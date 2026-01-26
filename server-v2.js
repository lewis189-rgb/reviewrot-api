const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Environment variables
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
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

// IMPROVED: Search for business using multiple strategies
async function findBusiness(businessName, placeId = null) {
  // If we have a placeId from autocomplete, use it directly
  if (placeId) {
    try {
      const response = await axios.get(
        `https://places.googleapis.com/v1/places/${placeId}`,
        {
          headers: {
            'X-Goog-Api-Key': GOOGLE_API_KEY,
            'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,reviews'
          }
        }
      );
      if (response.data && response.data.id) {
        return response.data;
      }
    } catch (err) {
      console.log('PlaceId lookup failed, trying text search...');
    }
  }

  // Strategy 1: Direct text search
  let searchQueries = [
    businessName,
    `${businessName} business`,
    `${businessName} company`
  ];

  for (const query of searchQueries) {
    try {
      console.log(`Searching for: "${query}"`);
      const searchResponse = await axios.post(
        'https://places.googleapis.com/v1/places:searchText',
        { 
          textQuery: query,
          maxResultCount: 5
        },
        {
          headers: {
            'X-Goog-Api-Key': GOOGLE_API_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.types'
          }
        }
      );

      if (searchResponse.data.places && searchResponse.data.places.length > 0) {
        // Find best match - prioritize businesses, not just locations
        let bestMatch = searchResponse.data.places[0];
        
        for (const place of searchResponse.data.places) {
          // Check if name closely matches
          const placeName = place.displayName?.text?.toLowerCase() || '';
          const searchName = businessName.toLowerCase();
          
          if (placeName.includes(searchName) || searchName.includes(placeName)) {
            bestMatch = place;
            break;
          }
        }

        // Get full details including reviews
        const detailsResponse = await axios.get(
          `https://places.googleapis.com/v1/places/${bestMatch.id}`,
          {
            headers: {
              'X-Goog-Api-Key': GOOGLE_API_KEY,
              'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,reviews'
            }
          }
        );

        if (detailsResponse.data) {
          return detailsResponse.data;
        }
      }
    } catch (err) {
      console.log(`Search failed for "${query}":`, err.message);
    }
  }

  return null;
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
    const { email, businessName, placeId } = req.body;

    if (!email || !businessName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and business name are required' 
      });
    }

    console.log(`\n=== New Request ===`);
    console.log(`Business: ${businessName}`);
    console.log(`PlaceId: ${placeId || 'none'}`);

    // Find business using improved search
    const place = await findBusiness(businessName, placeId);

    if (!place) {
      console.log('Business not found');
      
      // Still save the lead even if not found
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
      
      // Fire webhooks async
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
      // Sort reviews by publish time (most recent first)
      const sortedReviews = place.reviews.sort((a, b) => {
        return new Date(b.publishTime) - new Date(a.publishTime);
      });
      
      const lastReviewDate = new Date(sortedReviews[0].publishTime);
      const now = new Date();
      daysSinceReview = Math.floor((now - lastReviewDate) / (1000 * 60 * 60 * 24));
    }

    const rotScore = calculateRotScore(daysSinceReview);
    const { status, urgency } = getStatus(rotScore);

    const result = {
      success: true,
      found: true,
      businessName: place.displayName?.text || businessName,
      address: place.formattedAddress || 'Service area business',
      rotScore,
      status,
      urgency,
      daysSinceReview,
      totalReviews: place.userRatingCount || 0,
      avgRating: place.rating || 0,
      daysUntilDanger: Math.max(0, 70 - daysSinceReview),
      calendlyUrl: CALENDLY_URL
    };

    console.log(`Found: ${result.businessName}`);
    console.log(`Rot Score: ${rotScore}`);
    console.log(`Days Since Review: ${daysSinceReview}`);

    // Fire webhooks asynchronously (don't wait)
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
      googleApi: !!GOOGLE_API_KEY,
      airtable: !!AIRTABLE_API_KEY,
      zapier: !!ZAPIER_WEBHOOK_URL,
      slack: !!SLACK_WEBHOOK_URL
    }
  });
});

// Test Google API
app.get('/api/test/google', async (req, res) => {
  try {
    const testBusiness = req.query.q || 'Starbucks New York';
    const place = await findBusiness(testBusiness);
    
    if (place) {
      res.json({
        success: true,
        found: true,
        name: place.displayName?.text,
        address: place.formattedAddress,
        rating: place.rating,
        reviews: place.userRatingCount,
        hasReviewData: !!(place.reviews && place.reviews.length > 0)
      });
    } else {
      res.json({ success: true, found: false });
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
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
