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
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const CALENDLY_URL = process.env.CALENDLY_URL || 'https://calendly.com/seanmichaellewis';

// Calculate Rot Score
function calculateRotScore(daysSinceReview) {
  if (daysSinceReview <= 14) return Math.round((daysSinceReview / 14) * 10);
  if (daysSinceReview <= 21) return Math.round(10 + ((daysSinceReview - 14) / 7) * 20);
  if (daysSinceReview <= 56) return Math.round(30 + ((daysSinceReview - 21) / 35) * 30);
  if (daysSinceReview <= 70) return Math.round(60 + ((daysSinceReview - 56) / 14) * 20);
  return Math.min(100, Math.round(80 + ((daysSinceReview - 70) / 30) * 20));
}

// Get status from rot score
function getStatus(rotScore) {
  if (rotScore <= 10) return { status: 'Healthy Heartbeat', urgency: 'low' };
  if (rotScore <= 30) return { status: 'Early Decay', urgency: 'medium' };
  if (rotScore <= 60) return { status: 'Freshness Failing', urgency: 'high' };
  if (rotScore <= 80) return { status: 'Rot Zone', urgency: 'critical' };
  return { status: 'Critical Decay', urgency: 'critical' };
}

// Parse relative date like "a month ago", "2 months ago", "a week ago"
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

// Search for business using SerpAPI Google Maps
async function findBusinessWithSerpAPI(businessName) {
  try {
    console.log(`SerpAPI searching for: "${businessName}"`);
    
    const searchUrl = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(businessName)}&type=search&api_key=${SERPAPI_KEY}`;
    
    const searchResponse = await axios.get(searchUrl);
    const data = searchResponse.data;
    
    let place = null;
    
    // Check for local_results (multiple results)
    if (data.local_results && data.local_results.length > 0) {
      place = data.local_results[0];
      console.log('Found in local_results');
    }
    // Check for place_results (single exact match)
    else if (data.place_results) {
      place = data.place_results;
      console.log('Found in place_results');
    }
    
    if (!place) {
      console.log('No results found');
      return null;
    }

    console.log(`Found place: ${place.title}`);
    console.log(`Rating: ${place.rating}, Reviews: ${place.reviews}`);
    
    // Get the Google Maps URL
    let mapsUrl = null;
    if (place.place_id) {
      mapsUrl = `https://www.google.com/maps/place/?q=place_id:${place.place_id}`;
    } else if (place.data_id) {
      // Construct search URL with business name and address
      const searchQuery = place.address ? `${place.title} ${place.address}` : place.title;
      mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery)}`;
    } else {
      mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.title)}`;
    }
    
    // Also check for direct link from SerpAPI
    if (place.link) {
      mapsUrl = place.link;
    }
    
    // Get reviews using data_id
    const dataId = place.data_id;
    let reviews = [];
    
    if (dataId) {
      try {
        console.log(`Fetching reviews for data_id: ${dataId}`);
        const reviewsUrl = `https://serpapi.com/search.json?engine=google_maps_reviews&data_id=${dataId}&sort_by=newestFirst&api_key=${SERPAPI_KEY}`;
        
        const reviewsResponse = await axios.get(reviewsUrl);
        reviews = reviewsResponse.data.reviews || [];
        console.log(`Got ${reviews.length} reviews`);
        
        if (reviews.length > 0) {
          console.log('Newest review date:', reviews[0].date);
        }
      } catch (reviewErr) {
        console.log('Could not get reviews:', reviewErr.message);
      }
    }

    return {
      name: place.title,
      address: place.address || 'Service area business',
      rating: place.rating || 0,
      totalReviews: place.reviews || 0,
      reviews: reviews,
      dataId: dataId,
      mapsUrl: mapsUrl,
      placeId: place.place_id || null
    };

  } catch (err) {
    console.error('SerpAPI error:', err.message);
    return null;
  }
}

// Save to Airtable (non-blocking)
async function saveToAirtable(leadData) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return;
  
  try {
    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`,
      {
        records: [{
          fields: {
            'Email': leadData.email,
            'Business Name': leadData.businessName,
            'Rot Score': leadData.rotScore,
            'Status': leadData.status,
            'Days Since Review': leadData.daysSinceReview,
            'Total Reviews': leadData.totalReviews,
            'Avg Rating': leadData.avgRating
          }
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Lead saved to Airtable');
  } catch (err) {
    console.error('Airtable error:', err.message);
  }
}

// Send to Zapier (non-blocking)
async function sendToZapier(leadData) {
  if (!ZAPIER_WEBHOOK_URL) return;
  
  try {
    await axios.post(ZAPIER_WEBHOOK_URL, leadData);
    console.log('Zapier webhook sent');
  } catch (err) {
    console.error('Zapier error:', err.message);
  }
}

// Send Slack alert (non-blocking)
async function sendSlackAlert(leadData) {
  if (!SLACK_WEBHOOK_URL || leadData.rotScore < 60) return;
  
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `🔥 HOT LEAD: ${leadData.businessName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*🔥 HOT LEAD ALERT*\n\n*Business:* ${leadData.businessName}\n*Email:* ${leadData.email}\n*Rot Score:* ${leadData.rotScore}\n*Days Silent:* ${leadData.daysSinceReview}`
          }
        }
      ]
    });
    console.log('Slack alert sent');
  } catch (err) {
    console.error('Slack error:', err.message);
  }
}

// Main calculation endpoint
app.post('/api/calculate-rot', async (req, res) => {
  try {
    const { email, businessName } = req.body;

    if (!email || !businessName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and business name are required' 
      });
    }

    console.log(`\n=== New Request ===`);
    console.log(`Business: ${businessName}`);

    const place = await findBusinessWithSerpAPI(businessName);

    if (!place) {
      console.log('Business not found');
      
      const notFoundLead = {
        email,
        businessName,
        rotScore: null,
        status: 'Not Found',
        daysSinceReview: null,
        totalReviews: null,
        avgRating: null,
        found: false
      };
      
      saveToAirtable(notFoundLead);
      sendToZapier(notFoundLead);

      return res.json({
        success: true,
        found: false,
        businessName,
        message: 'Business not found on Google'
      });
    }

    // Calculate days since last review
    let daysSinceReview = 999;
    
    if (place.reviews && place.reviews.length > 0) {
      const newestReview = place.reviews[0];
      
      if (newestReview.date) {
        const reviewDate = parseRelativeDate(newestReview.date);
        if (reviewDate) {
          const now = new Date();
          daysSinceReview = Math.floor((now - reviewDate) / (1000 * 60 * 60 * 24));
          console.log(`Newest review: "${newestReview.date}" = ${daysSinceReview} days ago`);
        }
      }
    }

    const rotScore = calculateRotScore(daysSinceReview);
    const { status, urgency } = getStatus(rotScore);

    const result = {
      success: true,
      found: true,
      businessName: place.name || businessName,
      address: place.address || 'Service area business',
      rotScore,
      status,
      urgency,
      daysSinceReview,
      totalReviews: place.totalReviews || 0,
      avgRating: place.rating || 0,
      daysUntilDanger: Math.max(0, 70 - daysSinceReview),
      calendlyUrl: CALENDLY_URL,
      mapsUrl: place.mapsUrl || null
    };

    console.log(`SUCCESS: ${result.businessName} - Rot Score: ${rotScore}`);

    const leadData = { email, ...result };
    saveToAirtable(leadData);
    sendToZapier(leadData);
    sendSlackAlert(leadData);

    res.json(result);

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Server error',
      message: error.message 
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      serpapi: !!SERPAPI_KEY,
      airtable: !!AIRTABLE_API_KEY,
      zapier: !!ZAPIER_WEBHOOK_URL,
      slack: !!SLACK_WEBHOOK_URL
    }
  });
});

// Test SerpAPI
app.get('/api/test/serpapi', async (req, res) => {
  try {
    const testBusiness = req.query.q || 'Starbucks New York';
    
    const searchUrl = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(testBusiness)}&type=search&api_key=${SERPAPI_KEY}`;
    const searchResponse = await axios.get(searchUrl);
    const data = searchResponse.data;
    
    let place = null;
    let source = null;
    
    if (data.local_results && data.local_results.length > 0) {
      place = data.local_results[0];
      source = 'local_results';
    } else if (data.place_results) {
      place = data.place_results;
      source = 'place_results';
    }
    
    if (place) {
      let reviews = [];
      let newestReviewDate = null;
      
      if (place.data_id) {
        try {
          const reviewsUrl = `https://serpapi.com/search.json?engine=google_maps_reviews&data_id=${place.data_id}&sort_by=newestFirst&api_key=${SERPAPI_KEY}`;
          const reviewsResponse = await axios.get(reviewsUrl);
          reviews = reviewsResponse.data.reviews || [];
          if (reviews.length > 0) {
            newestReviewDate = reviews[0].date;
          }
        } catch (e) {
          console.log('Could not fetch reviews');
        }
      }
      
      // Get maps URL
      let mapsUrl = place.link || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.title)}`;
      
      res.json({
        success: true,
        found: true,
        source: source,
        name: place.title,
        address: place.address,
        rating: place.rating,
        totalReviews: place.reviews,
        dataId: place.data_id,
        reviewsReturned: reviews.length,
        newestReviewDate: newestReviewDate,
        mapsUrl: mapsUrl
      });
    } else {
      res.json({ 
        success: true, 
        found: false,
        responseKeys: Object.keys(data)
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test Zapier
app.get('/api/test/zapier', async (req, res) => {
  if (!ZAPIER_WEBHOOK_URL) {
    return res.json({ success: false, error: 'Zapier webhook not configured' });
  }
  
  try {
    await axios.post(ZAPIER_WEBHOOK_URL, {
      test: true,
      email: 'test@example.com',
      businessName: 'Test Business',
      rotScore: 50
    });
    res.json({ success: true, message: 'Test webhook sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test Slack
app.get('/api/test/slack', async (req, res) => {
  if (!SLACK_WEBHOOK_URL) {
    return res.json({ success: false, error: 'Slack webhook not configured' });
  }
  
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: '🧪 Test alert from ReviewRot API'
    });
    res.json({ success: true, message: 'Test Slack message sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ReviewRot API running on port ${PORT}`);
  console.log(`SerpAPI Key configured: ${!!SERPAPI_KEY}`);
});
