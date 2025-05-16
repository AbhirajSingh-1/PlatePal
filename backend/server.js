const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const FormData = require('form-data');
const sharp = require('sharp');
const https = require('https');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());



// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

// In-memory storage for health profiles (in production, use a database)
const healthProfiles = {};

// Database of common food nutrition values (per 100g serving)
const nutritionDatabase = {
  'pizza': { calories: '285', protein: '12', carbohydrates: '36', fat: '10' },
  'samosa': { calories: '260', protein: '5', carbohydrates: '28', fat: '15' },
  'burger': { calories: '354', protein: '20', carbohydrates: '40', fat: '17' },
  'pasta': { calories: '220', protein: '8', carbohydrates: '43', fat: '1' },
  'salad': { calories: '100', protein: '3', carbohydrates: '10', fat: '5' },
  'bread': { calories: '265', protein: '9', carbohydrates: '49', fat: '3' },
  'rice': { calories: '204', protein: '4', carbohydrates: '45', fat: '0.5' },
  'steak': { calories: '252', protein: '26', carbohydrates: '0', fat: '17' },
  'chicken': { calories: '165', protein: '31', carbohydrates: '0', fat: '3.6' },
  'fish': { calories: '136', protein: '22', carbohydrates: '0', fat: '5' },
  'apple': { calories: '52', protein: '0.3', carbohydrates: '14', fat: '0.2' },
  'banana': { calories: '96', protein: '1.2', carbohydrates: '23', fat: '0.2' },
  'orange': { calories: '47', protein: '0.9', carbohydrates: '12', fat: '0.1' },
  'ice cream': { calories: '207', protein: '3.5', carbohydrates: '24', fat: '11' },
  'chocolate': { calories: '546', protein: '5.5', carbohydrates: '60', fat: '31' },
  'default': { calories: '250', protein: '10', carbohydrates: '30', fat: '10' }
};

const clientPath = path.join(__dirname, 'client');

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientPath));

  app.get('*', (req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });
}



// Routes
app.post('/api/analyze-food', upload.single('foodImage'), async (req, res) => {
  let compressedImagePath = '';
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    console.log("File received:", req.file);

    // Create a compressed JPEG file
    compressedImagePath = path.join(__dirname, 'uploads', 'compressed-' + req.file.filename);
    
    // Process with Sharp - resize and convert to JPEG
    await sharp(req.file.path)
      .resize(600)
      .jpeg({ quality: 70 })
      .toFile(compressedImagePath);
    
    // Read the compressed file
    const imageBuffer = fs.readFileSync(compressedImagePath);
    
    // LogMeal API integration
    const logMealApiKey = process.env.LOGMEAL_API_KEY;
    const logMealUrl = 'https://api.logmeal.es/v2/image/recognition/dish';
    
    // Create FormData and append image
    const formData = new FormData();
    formData.append('image', imageBuffer, {
      filename: 'food-image.jpg',
      contentType: 'image/jpeg'
    });
    
    console.log("Sending request to LogMeal API...");
    
    // Send request to LogMeal API
    const logMealResponse = await axios.post(logMealUrl, formData, {
      headers: {
        'Authorization': `Bearer ${logMealApiKey}`,
        ...formData.getHeaders()
      }
    });
    
    console.log("LogMeal API response received");
    
    // Process LogMeal response
    const foodIdentification = logMealResponse.data;
    
    // Extract food name from the recognition results
    let foodName = 'Unknown Food';
    let nutritionInfo = {
      name: 'Unknown Food',
      nutrition: {
        calories: 'N/A',
        protein: 'N/A',
        carbohydrates: 'N/A',
        fat: 'N/A'
      }
    };
    
    if (foodIdentification.recognition_results && 
        foodIdentification.recognition_results.length > 0) {
      
      const foodId = foodIdentification.recognition_results[0].id;
      foodName = foodIdentification.recognition_results[0].name;
      
      console.log(`Identified food: ${foodName} (ID: ${foodId})`);
      nutritionInfo.name = foodName;
      
      // Try to get nutrition info from LogMeal API
      try {
        const nutritionUrl = `https://api.logmeal.es/v2/recipe/info/${foodId}`;
        console.log(`Fetching nutrition data from: ${nutritionUrl}`);
        
        const nutritionResponse = await axios.get(nutritionUrl, {
          headers: { 'Authorization': `Bearer ${logMealApiKey}` }
        });
        
        if (nutritionResponse.data && nutritionResponse.data.nutrition) {
          nutritionInfo = nutritionResponse.data;
          console.log("Nutrition data retrieved successfully");
        }
      } 
      catch (nutritionError) {
        console.log("Failed to get detailed nutrition, trying alternative endpoint");
        
        try {
          const altNutritionUrl = `https://api.logmeal.es/v2/nutrition/recipe/${foodId}`;
          console.log(`Trying alternative endpoint: ${altNutritionUrl}`);
          
          const altNutritionResponse = await axios.get(altNutritionUrl, {
            headers: { 'Authorization': `Bearer ${logMealApiKey}` }
          });
          
          if (altNutritionResponse.data && altNutritionResponse.data.nutrition) {
            nutritionInfo = altNutritionResponse.data;
            console.log("Alternative nutrition data retrieved");
          }
        } 
        catch (altError) {
          console.error("Both nutrition endpoints failed:", altError.message);
          
          // If API nutrition data retrieval failed, use our database
          console.log("Using local nutrition database as fallback");
          
          // Check if the food is in our database (case insensitive)
          const foodNameLower = foodName.toLowerCase();
          let nutritionValues = null;
          
          // Look for exact match
          if (nutritionDatabase[foodNameLower]) {
            nutritionValues = nutritionDatabase[foodNameLower];
          } else {
            // Look for partial matches
            for (const [dbFood, dbValues] of Object.entries(nutritionDatabase)) {
              if (foodNameLower.includes(dbFood) || dbFood.includes(foodNameLower)) {
                nutritionValues = dbValues;
                break;
              }
            }
            
            // If still no match, use default values
            if (!nutritionValues) {
              nutritionValues = nutritionDatabase.default;
            }
          }
          
          nutritionInfo.nutrition = {
            calories: nutritionValues.calories,
            protein: nutritionValues.protein,
            carbohydrates: nutritionValues.carbohydrates,
            fat: nutritionValues.fat
          };
          
          console.log("Applied nutrition values:", nutritionInfo.nutrition);
        }
      }
    }
    
    // Get user profile
    const userId = req.body.userId || 'default';
    const userProfile = healthProfiles[userId] || {};
    
    // Get recommendations from Grok API
    const recommendations = await getGrokRecommendations(nutritionInfo, userProfile);
    
    // Send combined response to client
    const result = {
      name: nutritionInfo.name,
      calories: nutritionInfo.nutrition?.calories || 'N/A',
      protein: nutritionInfo.nutrition?.protein || 'N/A',
      carbs: nutritionInfo.nutrition?.carbohydrates || 'N/A',
      fat: nutritionInfo.nutrition?.fat || 'N/A',
      recommendations: recommendations
    };
    
    res.json(result);
    
  } catch (error) {
    console.error('Error analyzing food:', error.message);
    if (error.response) {
      console.error('API Response Error:', {
        status: error.response.status,
        data: error.response.data
      });
    }
    res.status(500).json({ error: 'Failed to analyze food image', details: error.message });
  } finally {
    // Clean up uploaded files
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      if (compressedImagePath && fs.existsSync(compressedImagePath)) {
        fs.unlinkSync(compressedImagePath);
      }
    } catch (cleanupError) {
      console.error('Error cleaning up files:', cleanupError);
    }
  }
});

app.post('/api/save-health-profile', (req, res) => {
  try {
    const profileData = req.body;
    const userId = req.body.userId || 'default';
    healthProfiles[userId] = profileData;
    res.status(200).json({ message: 'Health profile saved successfully' });
  } catch (error) {
    console.error('Error saving health profile:', error);
    res.status(500).json({ error: 'Failed to save health profile' });
  }
});

// Helper function to get recommendations from Grok API
async function getGrokRecommendations(nutritionInfo, userProfile) {
  const grokApiKey = process.env.GROK_API_KEY;
  const grokApiUrl = process.env.GROK_API_URL;
  
  if (!grokApiKey || !grokApiUrl) {
    return "For personalized recommendations, please complete your health profile. Generally, this food can be part of a balanced diet when consumed in appropriate portions.";
  }
  
  try {
    // Generate prompt for Grok API
    const prompt = `
      Analyze this food: ${nutritionInfo.name || 'Unknown food'}
      
      Nutritional information:
      - Calories: ${nutritionInfo.nutrition?.calories || 'unknown'} kcal
      - Protein: ${nutritionInfo.nutrition?.protein || 'unknown'} g
      - Carbohydrates: ${nutritionInfo.nutrition?.carbohydrates || 'unknown'} g
      - Fat: ${nutritionInfo.nutrition?.fat || 'unknown'} g
      
      User health profile:
      - Age: ${userProfile.age || 'unknown'}
      - Gender: ${userProfile.gender || 'unknown'}
      - Weight: ${userProfile.weight || 'unknown'} kg
      - Height: ${userProfile.height || 'unknown'} cm
      - Health conditions: ${userProfile.healthConditions || 'none specified'}
      - Dietary preferences: ${userProfile.dietaryPreferences || 'none specified'}
      - Allergies: ${userProfile.allergies || 'none specified'}
      
      'You are a nutritional advisor. Provide helpful health recommendations for the identified food considering the user\'s health condition. Keep the advice concise, practical, and informative. Focus on nutritional benefits or concerns, portion recommendations, and healthy preparation methods.'
    `;
    
    // Parse URL to get hostname for SNI
    const url = new URL(grokApiUrl);
    
    // Create a custom HTTPS agent to solve SSL issues
    const httpsAgent = new https.Agent({
      rejectUnauthorized: true, // Set to true for production
      servername: url.hostname // Important for SNI
    });
    
    // Make request to Grok API
    const response = await axios.post(grokApiUrl, {
      prompt: prompt,
      max_tokens: 150
    }, {
      headers: {
        'Authorization': `Bearer ${grokApiKey}`,
        'Content-Type': 'application/json'
      },
      httpsAgent: httpsAgent
    });
    
    return response.data.choices[0].text.trim();
    
  } catch (error) {
    console.error('Error calling Grok API:', error.message);
    
    // If there's an SSL error, try with verification disabled
    if (error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || 
        error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        error.code === 'EPROTO') {
      
      console.log('SSL certificate error, trying with verification disabled...');
      
      try {
        const url = new URL(grokApiUrl);
        const insecureAgent = new https.Agent({
          rejectUnauthorized: false,
          servername: url.hostname
        });
        
        const response = await axios.post(grokApiUrl, {
          prompt: prompt,
          max_tokens: 150
        }, {
          headers: {
            'Authorization': `Bearer ${grokApiKey}`,
            'Content-Type': 'application/json'
          },
          httpsAgent: insecureAgent
        });
        
        return response.data.choices[0].text.trim();
      } catch (retryError) {
        console.error('Still failed with SSL verification disabled:', retryError.message);
      }
    }
    
    // Fallback message if API call fails
    return "Based on this food's nutritional profile, consider balancing this meal with additional vegetables. Watch your portion size and be mindful of preparation methods to ensure a healthy meal.";
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});