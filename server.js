const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Environment variables
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Leads';
const AIRTABLE_AUDIT_TABLE = process.env.AIRTABLE_AUDIT_TABLE || 'GBP_Audits';
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const CALENDLY_URL = process.env.CALENDLY_URL || 'https://calendly.com/seanmichaellewis';

// ============================================
// SCORING FUNCTIONS
// ============================================

// Calculate Review Rot Score (0-100, lower is better)
function calculateRotScore(daysSinceReview) {
  if (daysSinceReview <= 14) return Math.round((daysSinceReview / 14) * 10);
  if (daysSinceReview <= 21) return Math.round(10 + ((daysSinceReview - 14) / 7) * 20);
  if (daysSinceReview <= 56) return Math.round(30 + ((daysSinceReview - 21) / 35) * 30);
  if (daysSinceReview <= 70) return Math.round(60 + ((daysSinceReview - 56) / 14) * 20);
  return Math.min(100, Math.round(80 + ((daysSinceReview - 70) / 30) * 20));
}

// Calculate Review Health Score (0-100, higher is better) - INVERSE of rot
function calculateReviewHealthScore(daysSinceReview, totalReviews, avgRating) {
  // Freshness component (40%)
  let freshnessScore = 100 - calculateRotScore(daysSinceReview);
  
  // Volume component (30%)
  let volumeScore = Math.min(100, (totalReviews / 100) * 100);
  
  // Quality component (30%)
  let qualityScore = (avgRating / 5) * 100;
  
  return Math.round((freshnessScore * 0.4) + (volumeScore * 0.3) + (qualityScore * 0.3));
}

// Calculate Profile Completeness Score
function calculateProfileScore(placeData) {
  let score = 0;
  let maxScore = 0;
  let issues = [];
  let recommendations = [];

  // Business name (required - 10 pts)
  maxScore += 10;
  if (placeData.title) score += 10;
  else issues.push('Missing business name');

  // Address (10 pts)
  maxScore += 10;
  if (placeData.address && placeData.address !== 'Service area business') {
    score += 10;
  } else {
    score += 5; // Service area is okay
  }

  // Phone number (15 pts)
  maxScore += 15;
  if (placeData.phone) {
    score += 15;
  } else {
    issues.push('Missing phone number');
    recommendations.push('Add your phone number to your GBP profile');
  }

  // Website (15 pts)
  maxScore += 15;
  if (placeData.website) {
    score += 15;
  } else {
    issues.push('Missing website');
    recommendations.push('Add your website URL to capture more leads');
  }

  // Hours (15 pts)
  maxScore += 15;
  if (placeData.hours || placeData.operating_hours) {
    score += 15;
  } else {
    issues.push('Missing business hours');
    recommendations.push('Add your operating hours - customers need to know when you\'re available');
  }

  // Description (10 pts)
  maxScore += 10;
  if (placeData.description && placeData.description.length > 50) {
    score += 10;
  } else if (placeData.description) {
    score += 5;
    recommendations.push('Expand your business description (aim for 250+ characters)');
  } else {
    issues.push('Missing business description');
    recommendations.push('Add a detailed business description with your services and service area');
  }

  // Categories (15 pts)
  maxScore += 15;
  if (placeData.types && placeData.types.length >= 3) {
    score += 15;
  } else if (placeData.types && placeData.types.length >= 1) {
    score += 8;
    recommendations.push(`Add more business categories (you have ${placeData.types.length}, aim for 3-5)`);
  } else {
    issues.push('Missing business categories');
    recommendations.push('Add relevant business categories to appear in more searches');
  }

  // Service options/attributes (10 pts)
  maxScore += 10;
  if (placeData.service_options || placeData.extensions) {
    score += 10;
  } else {
    recommendations.push('Add service attributes (24/7, emergency service, free estimates, etc.)');
  }

  return {
    score: Math.round((score / maxScore) * 100),
    issues,
    recommendations
  };
}

// Calculate Photo Score
function calculatePhotoScore(photoCount, photoData) {
  let score = 0;
  let issues = [];
  let recommendations = [];

  if (photoCount >= 50) {
    score = 100;
  } else if (photoCount >= 25) {
    score = 75;
    recommendations.push(`Add ${50 - photoCount} more photos to reach optimal level`);
  } else if (photoCount >= 10) {
    score = 50;
    issues.push('Low photo count');
    recommendations.push('Businesses with 50+ photos get 520% more calls - add more photos!');
  } else if (photoCount >= 1) {
    score = 25;
    issues.push('Very few photos');
    recommendations.push('URGENT: Add more photos immediately - you\'re missing significant visibility');
  } else {
    score = 0;
    issues.push('NO PHOTOS');
    recommendations.push('CRITICAL: Add photos NOW - profiles without photos get 42% fewer requests for directions');
  }

  return { score, issues, recommendations, count: photoCount };
}

// Calculate Response Rate Score
function calculateResponseScore(reviews) {
  if (!reviews || reviews.length === 0) {
    return { 
      score: 0, 
      responseRate: 0,
      issues: ['No reviews to respond to'],
      recommendations: ['Get your first reviews, then respond to 100% of them']
    };
  }

  let responsesFound = 0;
  reviews.forEach(review => {
    if (review.response) responsesFound++;
  });

  const responseRate = Math.round((responsesFound / reviews.length) * 100);
  let score = responseRate;
  let issues = [];
  let recommendations = [];

  if (responseRate < 50) {
    issues.push(`Only ${responseRate}% response rate`);
    recommendations.push('Respond to ALL reviews - both positive and negative');
  } else if (responseRate < 100) {
    recommendations.push(`You're at ${responseRate}% response rate - aim for 100%`);
  }

  return { score, responseRate, issues, recommendations };
}

// Get status label from score
function getStatusFromScore(score) {
  if (score >= 90) return { status: 'Excellent', color: '#10b981' };
  if (score >= 70) return { status: 'Good', color: '#22c55e' };
  if (score >= 50) return { status: 'Fair', color: '#f59e0b' };
  if (score >= 30) return { status: 'Poor', color: '#f97316' };
  return { status: 'Critical', color: '#ef4444' };
}

// Parse relative date
function parseRelativeDate(relativeStr) {
  if (!relativeStr) return null;
  
  const now = new Date();
  const str = relativeStr.toLowerCase();
  
  if (str.includes('hour') || str.includes('minute') || str.includes('second')) {
    return now;
  }
  
  if (str.includes('day')) {
    const match = str.match(/(\d+)/);
    const days = match ? parseInt(match[1]) : 1;
    return new Date(now - days * 24 * 60 * 60 * 1000);
  }
  
  if (str.includes('week')) {
    const match = str.match(/(\d+)/);
    const weeks = match ? parseInt(match[1]) : 1;
    return new Date(now - weeks * 7 * 24 * 60 * 60 * 1000);
  }
  
  if (str.includes('month')) {
    const match = str.match(/(\d+)/);
    const months = match ? parseInt(match[1]) : 1;
    const date = new Date(now);
    date.setMonth(date.getMonth() - months);
    return date;
  }
  
  if (str.includes('year')) {
    const match = str.match(/(\d+)/);
    const years = match ? parseInt(match[1]) : 1;
    const date = new Date(now);
    date.setFullYear(date.getFullYear() - years);
    return date;
  }
  
  return null;
}

// ============================================
// SERPAPI FUNCTIONS
// ============================================

// Search for business
async function findBusinessWithSerpAPI(businessName) {
  try {
    console.log(`SerpAPI searching for: "${businessName}"`);
    
    const searchResponse = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_maps',
        q: businessName,
        type: 'search',
        api_key: SERPAPI_KEY
      }
    });

    const places = searchResponse.data.local_results;
    
    if (!places || places.length === 0) {
      console.log('No results from SerpAPI search');
      return null;
    }

    return places[0];
  } catch (err) {
    console.error('SerpAPI search error:', err.message);
    return null;
  }
}

// Get place details
async function getPlaceDetails(placeId) {
  try {
    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_maps',
        place_id: placeId,
        api_key: SERPAPI_KEY
      }
    });
    
    return response.data.place_results || null;
  } catch (err) {
    console.error('Place details error:', err.message);
    return null;
  }
}

// Get reviews sorted by newest
async function getReviews(dataId, sortBy = 'newestFirst') {
  try {
    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_maps_reviews',
        data_id: dataId,
        sort_by: sortBy,
        api_key: SERPAPI_KEY
      }
    });
    
    return response.data.reviews || [];
  } catch (err) {
    console.error('Reviews error:', err.message);
    return [];
  }
}

// Get photos
async function getPhotos(dataId) {
  try {
    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_maps_photos',
        data_id: dataId,
        api_key: SERPAPI_KEY
      }
    });
    
    return response.data.photos || [];
  } catch (err) {
    console.error('Photos error:', err.message);
    return [];
  }
}

// ============================================
// WEBHOOK FUNCTIONS
// ============================================

async function saveToAirtable(data, tableName = AIRTABLE_TABLE_NAME) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return;
  
  try {
    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableName}`,
      { records: [{ fields: data }] },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Saved to Airtable (${tableName})`);
  } catch (err) {
    console.error('Airtable error:', err.message);
  }
}

async function sendToZapier(data) {
  if (!ZAPIER_WEBHOOK_URL) return;
  
  try {
    await axios.post(ZAPIER_WEBHOOK_URL, data);
    console.log('Zapier webhook sent');
  } catch (err) {
    console.error('Zapier error:', err.message);
  }
}

async function sendSlackAlert(data) {
  if (!SLACK_WEBHOOK_URL) return;
  
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `🔍 New GBP Audit: ${data.businessName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*🔍 NEW GBP AUDIT*\n\n*Business:* ${data.businessName}\n*Email:* ${data.email}\n*Overall Score:* ${data.overallScore}/100\n*Status:* ${data.overallStatus}`
          }
        }
      ]
    });
    console.log('Slack alert sent');
  } catch (err) {
    console.error('Slack error:', err.message);
  }
}

// ============================================
// API ENDPOINTS
// ============================================

// Original calculate-rot endpoint (keep for backward compatibility)
app.post('/api/calculate-rot', async (req, res) => {
  try {
    const { email, businessName } = req.body;

    if (!email || !businessName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and business name are required' 
      });
    }

    console.log(`\n=== Calculate Rot Request ===`);
    console.log(`Business: ${businessName}`);

    const place = await findBusinessWithSerpAPI(businessName);

    if (!place) {
      const notFoundLead = {
        email,
        businessName,
        rotScore: null,
        status: 'Not Found',
        found: false
      };
      
      saveToAirtable({ 'Email': email, 'Business Name': businessName, 'Status': 'Not Found' });
      sendToZapier(notFoundLead);

      return res.json({
        success: true,
        found: false,
        businessName,
        message: 'Business not found on Google'
      });
    }

    // Get reviews
    let reviews = [];
    let daysSinceReview = 999;
    
    if (place.data_id) {
      reviews = await getReviews(place.data_id);
      
      if (reviews.length > 0 && reviews[0].date) {
        const reviewDate = parseRelativeDate(reviews[0].date);
        if (reviewDate) {
          daysSinceReview = Math.floor((new Date() - reviewDate) / (1000 * 60 * 60 * 24));
        }
      }
    }

    const rotScore = calculateRotScore(daysSinceReview);
    const { status } = getStatusFromScore(100 - rotScore);

    const result = {
      success: true,
      found: true,
      businessName: place.title || businessName,
      address: place.address || 'Service area business',
      rotScore,
      status,
      daysSinceReview,
      totalReviews: place.reviews || 0,
      avgRating: place.rating || 0,
      daysUntilDanger: Math.max(0, 70 - daysSinceReview),
      calendlyUrl: CALENDLY_URL
    };

    // Save lead
    const leadData = {
      'Email': email,
      'Business Name': result.businessName,
      'Rot Score': rotScore,
      'Status': status,
      'Days Since Review': daysSinceReview,
      'Total Reviews': result.totalReviews,
      'Avg Rating': result.avgRating
    };
    
    saveToAirtable(leadData);
    sendToZapier({ email, ...result });
    if (rotScore >= 60) sendSlackAlert({ email, ...result });

    res.json(result);

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// NEW: Full GBP Audit endpoint
app.post('/api/full-audit', async (req, res) => {
  try {
    const { email, businessName } = req.body;

    if (!email || !businessName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and business name are required' 
      });
    }

    console.log(`\n=== FULL GBP AUDIT ===`);
    console.log(`Business: ${businessName}`);
    console.log(`Email: ${email}`);

    // Step 1: Find the business
    const place = await findBusinessWithSerpAPI(businessName);

    if (!place) {
      saveToAirtable({ 
        'Email': email, 
        'Business Name': businessName, 
        'Status': 'Not Found',
        'Source': 'GBP Audit Tool'
      });
      
      return res.json({
        success: true,
        found: false,
        businessName,
        message: 'Business not found on Google'
      });
    }

    // Step 2: Get detailed place info if we have place_id
    let placeDetails = place;
    if (place.place_id) {
      const details = await getPlaceDetails(place.place_id);
      if (details) placeDetails = { ...place, ...details };
    }

    // Step 3: Get reviews (newest first)
    let reviews = [];
    let daysSinceReview = 999;
    
    if (place.data_id) {
      reviews = await getReviews(place.data_id, 'newestFirst');
      
      if (reviews.length > 0 && reviews[0].date) {
        const reviewDate = parseRelativeDate(reviews[0].date);
        if (reviewDate) {
          daysSinceReview = Math.floor((new Date() - reviewDate) / (1000 * 60 * 60 * 24));
        }
      }
    }

    // Step 4: Get photos
    let photos = [];
    if (place.data_id) {
      photos = await getPhotos(place.data_id);
    }

    // Step 5: Calculate all scores
    const rotScore = calculateRotScore(daysSinceReview);
    const reviewHealthScore = calculateReviewHealthScore(
      daysSinceReview, 
      place.reviews || 0, 
      place.rating || 0
    );
    const profileScore = calculateProfileScore(placeDetails);
    const photoScore = calculatePhotoScore(photos.length || placeDetails.photos?.length || 0, photos);
    const responseScore = calculateResponseScore(reviews);

    // Calculate overall score (weighted average)
    const overallScore = Math.round(
      (reviewHealthScore * 0.35) +    // Review health: 35%
      (profileScore.score * 0.25) +   // Profile completeness: 25%
      (photoScore.score * 0.20) +     // Photos: 20%
      (responseScore.score * 0.20)    // Response rate: 20%
    );

    const overallStatus = getStatusFromScore(overallScore);

    // Compile all issues and recommendations
    const allIssues = [
      ...profileScore.issues,
      ...photoScore.issues,
      ...responseScore.issues
    ];

    const allRecommendations = [
      ...profileScore.recommendations,
      ...photoScore.recommendations,
      ...responseScore.recommendations
    ];

    // Add review-specific recommendations
    if (daysSinceReview > 30) {
      allRecommendations.unshift(`Get a new review ASAP - it's been ${daysSinceReview} days!`);
    }
    if (daysSinceReview > 14 && daysSinceReview <= 30) {
      allRecommendations.push('Request reviews from recent customers to maintain freshness');
    }

    // Build comprehensive result
    const result = {
      success: true,
      found: true,
      
      // Business info
      businessName: placeDetails.title || businessName,
      address: placeDetails.address || 'Service area business',
      phone: placeDetails.phone || null,
      website: placeDetails.website || null,
      
      // Overall score
      overallScore,
      overallStatus: overallStatus.status,
      overallColor: overallStatus.color,
      
      // Individual scores
      scores: {
        reviewHealth: {
          score: reviewHealthScore,
          status: getStatusFromScore(reviewHealthScore).status,
          rotScore: rotScore,
          daysSinceReview,
          totalReviews: place.reviews || 0,
          avgRating: place.rating || 0
        },
        profileCompleteness: {
          score: profileScore.score,
          status: getStatusFromScore(profileScore.score).status,
          issues: profileScore.issues
        },
        photos: {
          score: photoScore.score,
          status: getStatusFromScore(photoScore.score).status,
          count: photoScore.count,
          issues: photoScore.issues
        },
        reviewResponses: {
          score: responseScore.score,
          status: getStatusFromScore(responseScore.score).status,
          responseRate: responseScore.responseRate,
          issues: responseScore.issues
        }
      },
      
      // Categories
      categories: placeDetails.types || placeDetails.type ? 
        (placeDetails.types || [placeDetails.type]) : [],
      
      // Hours
      hours: placeDetails.operating_hours || placeDetails.hours || null,
      
      // Service options
      serviceOptions: placeDetails.service_options || null,
      
      // Extensions/attributes
      attributes: placeDetails.extensions || null,
      
      // Issues & Recommendations
      criticalIssues: allIssues.slice(0, 5),
      topRecommendations: allRecommendations.slice(0, 5),
      
      // Potential impact
      potentialImpact: {
        estimatedMissedCalls: overallScore < 70 ? Math.round((70 - overallScore) * 0.5) : 0,
        visibilityLoss: overallScore < 70 ? `${Math.round((70 - overallScore) * 1.5)}%` : '0%',
        monthlyRevenueAtRisk: overallScore < 70 ? 
          `$${Math.round((70 - overallScore) * 150).toLocaleString()} - $${Math.round((70 - overallScore) * 300).toLocaleString()}` : '$0'
      },
      
      // CTA
      calendlyUrl: CALENDLY_URL
    };

    console.log(`Overall Score: ${overallScore}/100 (${overallStatus.status})`);

    // Save to Airtable (audit-specific table)
    const auditData = {
      'Email': email,
      'Business Name': result.businessName,
      'Overall Score': overallScore,
      'Status': overallStatus.status,
      'Review Health Score': reviewHealthScore,
      'Profile Score': profileScore.score,
      'Photo Score': photoScore.score,
      'Response Score': responseScore.score,
      'Days Since Review': daysSinceReview,
      'Total Reviews': place.reviews || 0,
      'Avg Rating': place.rating || 0,
      'Photo Count': photoScore.count,
      'Top Issues': allIssues.slice(0, 3).join('; '),
      'Source': 'GBP Audit Tool'
    };
    
    saveToAirtable(auditData, AIRTABLE_AUDIT_TABLE);
    
    // Also save to regular leads table
    saveToAirtable({
      'Email': email,
      'Business Name': result.businessName,
      'Rot Score': rotScore,
      'Status': overallStatus.status,
      'Days Since Review': daysSinceReview,
      'Total Reviews': place.reviews || 0,
      'Avg Rating': place.rating || 0,
      'Source': 'GBP Audit Tool'
    });
    
    // Send to Zapier with full data
    sendToZapier({ 
      email, 
      tool: 'gbp-audit',
      ...result 
    });
    
    // Slack alert for poor scores
    if (overallScore < 50) {
      sendSlackAlert({ email, businessName: result.businessName, overallScore, overallStatus: overallStatus.status });
    }

    res.json(result);

  } catch (error) {
    console.error('Full Audit Error:', error);
    res.status(500).json({ success: false, error: 'Server error', message: error.message });
  }
});

// Quick audit endpoint (lighter weight, fewer API calls)
app.post('/api/quick-audit', async (req, res) => {
  try {
    const { email, businessName } = req.body;

    if (!businessName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Business name is required' 
      });
    }

    console.log(`\n=== Quick Audit ===`);
    console.log(`Business: ${businessName}`);

    const place = await findBusinessWithSerpAPI(businessName);

    if (!place) {
      return res.json({
        success: true,
        found: false,
        businessName
      });
    }

    // Get reviews only
    let reviews = [];
    let daysSinceReview = 999;
    
    if (place.data_id) {
      reviews = await getReviews(place.data_id, 'newestFirst');
      
      if (reviews.length > 0 && reviews[0].date) {
        const reviewDate = parseRelativeDate(reviews[0].date);
        if (reviewDate) {
          daysSinceReview = Math.floor((new Date() - reviewDate) / (1000 * 60 * 60 * 24));
        }
      }
    }

    const reviewHealthScore = calculateReviewHealthScore(
      daysSinceReview, 
      place.reviews || 0, 
      place.rating || 0
    );

    const result = {
      success: true,
      found: true,
      businessName: place.title || businessName,
      address: place.address || 'Service area business',
      reviewHealthScore,
      status: getStatusFromScore(reviewHealthScore).status,
      daysSinceReview,
      totalReviews: place.reviews || 0,
      avgRating: place.rating || 0,
      dataId: place.data_id,
      placeId: place.place_id
    };

    // Save if email provided
    if (email) {
      saveToAirtable({
        'Email': email,
        'Business Name': result.businessName,
        'Rot Score': calculateRotScore(daysSinceReview),
        'Status': result.status,
        'Days Since Review': daysSinceReview,
        'Source': 'Quick Audit'
      });
    }

    res.json(result);

  } catch (error) {
    console.error('Quick Audit Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    endpoints: ['/api/calculate-rot', '/api/full-audit', '/api/quick-audit'],
    config: {
      serpapi: !!SERPAPI_KEY,
      airtable: !!AIRTABLE_API_KEY,
      zapier: !!ZAPIER_WEBHOOK_URL,
      slack: !!SLACK_WEBHOOK_URL
    }
  });
});

// Test endpoint
app.get('/api/test/audit', async (req, res) => {
  const testBusiness = req.query.q || 'SERVPRO of St. Charles';
  
  try {
    const place = await findBusinessWithSerpAPI(testBusiness);
    
    if (place) {
      res.json({
        success: true,
        found: true,
        name: place.title,
        address: place.address,
        rating: place.rating,
        reviews: place.reviews,
        dataId: place.data_id,
        placeId: place.place_id,
        types: place.types,
        phone: place.phone,
        website: place.website
      });
    } else {
      res.json({ success: true, found: false });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`GBP Audit API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`SerpAPI configured: ${!!SERPAPI_KEY}`);
  console.log(`Endpoints: /api/calculate-rot, /api/full-audit, /api/quick-audit`);
});
