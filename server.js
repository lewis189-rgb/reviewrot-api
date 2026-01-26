/**
 * ============================================
 * REVIEWROT.COM - BACKEND API SERVER
 * ============================================
 * 
 * This handles:
 * 1. Google Places API lookup (find business, get reviews)
 * 2. Rot Score calculation
 * 3. Lead capture to Airtable
 * 4. Webhook triggers to Zapier for email automation
 * 5. Slack notifications for hot leads
 * 
 * Stack: Node.js + Express
 * Deploy: Vercel, Railway, Render, or any Node host
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const config = {
  // Google Places API
  googleApiKey: process.env.GOOGLE_PLACES_API_KEY,
  
  // Airtable
  airtableApiKey: process.env.AIRTABLE_API_KEY,
  airtableBaseId: process.env.AIRTABLE_BASE_ID,
  airtableTableName: process.env.AIRTABLE_TABLE_NAME || 'Leads',
  
  // Zapier Webhook (triggers email sequence)
  zapierWebhook: process.env.ZAPIER_WEBHOOK_URL,
  
  // Slack Webhook (hot lead alerts)
  slackWebhook: process.env.SLACK_WEBHOOK_URL,
  
  // Calendly link for CTA
  calendlyUrl: process.env.CALENDLY_URL || 'https://calendly.com/seanmichaellewis',
  
  // Hot lead threshold
  hotLeadThreshold: 60
};

// ============================================
// ROT SCORE CALCULATION ENGINE
// ============================================
function calculateRotScore(daysSinceReview) {
  let rotScore, status, urgency;
  
  if (daysSinceReview <= 14) {
    rotScore = Math.floor(daysSinceReview * 0.7);
    status = 'Healthy Heartbeat';
    urgency = 'low';
  } else if (daysSinceReview <= 21) {
    rotScore = Math.floor(11 + (daysSinceReview - 14) * 2.7);
    status = 'Early Decay';
    urgency = 'medium';
  } else if (daysSinceReview <= 56) {
    rotScore = Math.floor(31 + (daysSinceReview - 21) * 0.85);
    status = 'Freshness Failing';
    urgency = 'high';
  } else if (daysSinceReview <= 70) {
    rotScore = Math.floor(61 + (daysSinceReview - 56) * 1.35);
    status = 'Rot Zone';
    urgency = 'critical';
  } else {
    rotScore = Math.min(100, Math.floor(81 + (daysSinceReview - 70) * 0.5));
    status = 'Critical Decay';
    urgency = 'critical';
  }

  return { rotScore: Math.min(rotScore, 100), status, urgency };
}

// ============================================
// GOOGLE PLACES API - FIND BUSINESS & GET REVIEWS
// ============================================
async function getBusinessData(businessName) {
  try {
    // STEP 1: Search for the business
    console.log(`[Google API] Searching for: ${businessName}`);
    
    const searchResponse = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      { textQuery: businessName },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.googleApiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress'
        }
      }
    );

    if (!searchResponse.data.places || searchResponse.data.places.length === 0) {
      console.log('[Google API] Business not found');
      return { found: false, error: 'Business not found on Google' };
    }

    const place = searchResponse.data.places[0];
    const placeId = place.id;
    console.log(`[Google API] Found place: ${placeId}`);

    // STEP 2: Get detailed info including reviews
    const detailsResponse = await axios.get(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': config.googleApiKey,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,reviews'
        }
      }
    );

    const details = detailsResponse.data;
    console.log(`[Google API] Got details: ${details.userRatingCount} reviews, ${details.rating} rating`);
    
    // Find most recent review date
    let daysSinceReview = 365; // Default to max if no reviews
    let lastReviewDate = null;
    
    if (details.reviews && details.reviews.length > 0) {
      // Sort reviews by publishTime to find most recent
      const reviewDates = details.reviews
        .filter(r => r.publishTime)
        .map(r => new Date(r.publishTime))
        .sort((a, b) => b - a);
      
      if (reviewDates.length > 0) {
        lastReviewDate = reviewDates[0];
        daysSinceReview = Math.floor((Date.now() - lastReviewDate) / (1000 * 60 * 60 * 24));
        console.log(`[Google API] Most recent review: ${daysSinceReview} days ago`);
      }
    }

    return {
      found: true,
      placeId,
      businessName: details.displayName?.text || businessName,
      address: details.formattedAddress || '',
      totalReviews: details.userRatingCount || 0,
      avgRating: details.rating || 0,
      daysSinceReview,
      lastReviewDate: lastReviewDate?.toISOString() || null,
      reviewCount: details.reviews?.length || 0
    };

  } catch (error) {
    console.error('[Google API] Error:', error.response?.data || error.message);
    return { found: false, error: 'Failed to lookup business' };
  }
}

// ============================================
// AIRTABLE - SAVE LEAD
// ============================================
async function saveToAirtable(leadData) {
  if (!config.airtableApiKey || !config.airtableBaseId) {
    console.log('[Airtable] Skipping - not configured');
    return null;
  }

  try {
    const response = await axios.post(
      `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableTableName)}`,
      {
        fields: {
          'Email': leadData.email,
          'Business Name': leadData.businessName,
          'Address': leadData.address || '',
          'Rot Score': leadData.rotScore,
          'Status': leadData.status,
          'Urgency': leadData.urgency,
          'Days Since Review': leadData.daysSinceReview,
          'Total Reviews': leadData.totalReviews,
          'Avg Rating': leadData.avgRating,
          'Source': 'ReviewRot Calculator',
          'Created': new Date().toISOString()
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.airtableApiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('[Airtable] Lead saved:', response.data.id);
    return response.data.id;
  } catch (error) {
    console.error('[Airtable] Error:', error.response?.data || error.message);
    return null;
  }
}

// ============================================
// ZAPIER WEBHOOK - TRIGGER EMAIL SEQUENCE
// ============================================
async function triggerZapier(leadData) {
  if (!config.zapierWebhook) {
    console.log('[Zapier] Skipping - not configured');
    return false;
  }

  try {
    const payload = {
      // Contact info
      email: leadData.email,
      business_name: leadData.businessName,
      address: leadData.address,
      
      // Score data
      rot_score: leadData.rotScore,
      status: leadData.status,
      urgency: leadData.urgency,
      days_since_review: leadData.daysSinceReview,
      total_reviews: leadData.totalReviews,
      avg_rating: leadData.avgRating,
      
      // Calculated fields for email personalization
      days_until_danger: Math.max(0, 70 - leadData.daysSinceReview),
      is_hot_lead: leadData.rotScore >= config.hotLeadThreshold,
      
      // Tags for email platform segmentation
      tags: [
        `rot_${leadData.urgency}`,
        leadData.rotScore >= config.hotLeadThreshold ? 'hot_lead' : 'nurture',
        'reviewrot_calculator'
      ].join(','),
      
      // Metadata
      source: 'reviewrot_calculator',
      timestamp: new Date().toISOString(),
      calendly_link: config.calendlyUrl
    };

    await axios.post(config.zapierWebhook, payload);
    console.log('[Zapier] Webhook triggered successfully');
    return true;
  } catch (error) {
    console.error('[Zapier] Error:', error.message);
    return false;
  }
}

// ============================================
// SLACK NOTIFICATION - HOT LEAD ALERT
// ============================================
async function sendSlackAlert(leadData) {
  if (!config.slackWebhook) {
    console.log('[Slack] Skipping - not configured');
    return false;
  }

  // Only alert for hot leads
  if (leadData.rotScore < config.hotLeadThreshold) {
    console.log('[Slack] Skipping - not a hot lead');
    return false;
  }

  try {
    const message = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🔥 HOT LEAD from ReviewRot',
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Business:*\n${leadData.businessName}`
            },
            {
              type: 'mrkdwn',
              text: `*Email:*\n${leadData.email}`
            },
            {
              type: 'mrkdwn',
              text: `*Rot Score:*\n${leadData.rotScore} (${leadData.status})`
            },
            {
              type: 'mrkdwn',
              text: `*Days Since Review:*\n${leadData.daysSinceReview}`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📍 ${leadData.address || 'No address'}\n⭐ ${leadData.avgRating} avg rating • ${leadData.totalReviews} total reviews`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '📧 Send Personal Email',
                emoji: true
              },
              url: `mailto:${leadData.email}?subject=Your%20ReviewRot%20Score%20Results&body=Hi%2C%0A%0AI%20saw%20you%20ran%20a%20diagnostic%20on%20${encodeURIComponent(leadData.businessName)}...`,
              style: 'primary'
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🔍 Google the Business',
                emoji: true
              },
              url: `https://www.google.com/search?q=${encodeURIComponent(leadData.businessName)}`
            }
          ]
        }
      ]
    };

    await axios.post(config.slackWebhook, message);
    console.log('[Slack] Alert sent for hot lead');
    return true;
  } catch (error) {
    console.error('[Slack] Error:', error.message);
    return false;
  }
}

// ============================================
// MAIN API ENDPOINT
// ============================================
app.post('/api/calculate-rot', async (req, res) => {
  const startTime = Date.now();
  console.log('\n========================================');
  console.log('[API] New calculation request');
  
  try {
    const { email, businessName } = req.body;

    // Validate inputs
    if (!email || !businessName) {
      return res.status(400).json({ 
        success: false,
        message: 'Email and business name are required' 
      });
    }

    console.log(`[API] Email: ${email}`);
    console.log(`[API] Business: ${businessName}`);

    // 1. Get business data from Google
    const businessData = await getBusinessData(businessName);
    
    if (!businessData.found) {
      // Still capture the lead even if business not found
      const fallbackLead = {
        email,
        businessName,
        rotScore: 100,
        status: 'Unknown',
        urgency: 'unknown',
        daysSinceReview: null,
        totalReviews: 0,
        avgRating: 0
      };
      
      // Fire webhooks for manual follow-up
      await Promise.all([
        saveToAirtable(fallbackLead),
        triggerZapier(fallbackLead)
      ]);

      return res.json({
        success: false,
        found: false,
        message: businessData.error || 'Business not found. We\'ll research manually and email you.'
      });
    }

    // 2. Calculate rot score
    const scoreData = calculateRotScore(businessData.daysSinceReview);

    // 3. Build complete result
    const result = {
      success: true,
      found: true,
      
      // Business info
      businessName: businessData.businessName,
      address: businessData.address,
      placeId: businessData.placeId,
      
      // Review metrics
      totalReviews: businessData.totalReviews,
      avgRating: businessData.avgRating,
      daysSinceReview: businessData.daysSinceReview,
      lastReviewDate: businessData.lastReviewDate,
      
      // Rot score
      rotScore: scoreData.rotScore,
      status: scoreData.status,
      urgency: scoreData.urgency,
      
      // Calculated
      daysUntilDanger: Math.max(0, 70 - businessData.daysSinceReview),
      
      // CTA
      calendlyUrl: config.calendlyUrl,
      
      // Meta
      processingTime: Date.now() - startTime
    };

    console.log(`[API] Rot Score: ${result.rotScore} (${result.status})`);

    // 4. Fire all integrations in parallel (don't block response)
    const leadData = { email, ...result };
    
    Promise.all([
      saveToAirtable(leadData),
      triggerZapier(leadData),
      sendSlackAlert(leadData)
    ]).then(() => {
      console.log('[API] All integrations completed');
    }).catch(err => {
      console.error('[API] Integration error:', err.message);
    });

    // 5. Return results immediately
    console.log(`[API] Response sent in ${Date.now() - startTime}ms`);
    return res.json(result);

  } catch (error) {
    console.error('[API] Error:', error);
    return res.status(500).json({ 
      success: false,
      message: 'Calculation failed. Please try again.' 
    });
  }
});

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    config: {
      googleApi: !!config.googleApiKey,
      airtable: !!config.airtableApiKey,
      zapier: !!config.zapierWebhook,
      slack: !!config.slackWebhook
    }
  });
});

// ============================================
// TEST ENDPOINTS (for development)
// ============================================
if (process.env.NODE_ENV !== 'production') {
  // Test Google API connection
  app.get('/api/test/google', async (req, res) => {
    const result = await getBusinessData('Starbucks New York');
    res.json(result);
  });
  
  // Test Zapier webhook
  app.get('/api/test/zapier', async (req, res) => {
    const testLead = {
      email: 'test@example.com',
      businessName: 'Test Business',
      rotScore: 75,
      status: 'Rot Zone',
      urgency: 'critical',
      daysSinceReview: 60,
      totalReviews: 50,
      avgRating: 4.5
    };
    const result = await triggerZapier(testLead);
    res.json({ success: result });
  });
  
  // Test Slack webhook  
  app.get('/api/test/slack', async (req, res) => {
    const testLead = {
      email: 'test@example.com',
      businessName: 'Test Business',
      address: '123 Test St',
      rotScore: 75,
      status: 'Rot Zone',
      urgency: 'critical',
      daysSinceReview: 60,
      totalReviews: 50,
      avgRating: 4.5
    };
    const result = await sendSlackAlert(testLead);
    res.json({ success: result });
  });
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🔴 ReviewRot API running on port ${PORT}`);
  console.log('========================================');
  console.log('Configuration:');
  console.log(`  Google API: ${config.googleApiKey ? '✓ Configured' : '✗ Missing'}`);
  console.log(`  Airtable:   ${config.airtableApiKey ? '✓ Configured' : '✗ Missing'}`);
  console.log(`  Zapier:     ${config.zapierWebhook ? '✓ Configured' : '✗ Missing'}`);
  console.log(`  Slack:      ${config.slackWebhook ? '✓ Configured' : '✗ Missing'}`);
  console.log('========================================\n');
});

module.exports = app;
