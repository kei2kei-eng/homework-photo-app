const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const multer = require('multer');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Multer setup for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Email transporter setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

// JWT middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Helper function to check homework answers using LLaVA via Replicate
async function checkAnswersWithAI(base64Image, question = '') {
  try {
    console.log('Starting LLaVA homework verification...');
    
    const prompt = `You are a homework verification assistant. Analyze this homework image and verify the answers.
    
${question ? `Question: ${question}` : 'Identify all visible answers or questions in the image.'}

Return ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "isCorrect": true or false,
  "score": 0-100,
  "answers": [
    {
      "text": "answer text",
      "isCorrect": true or false
    }
  ],
  "feedback": "brief feedback about the homework"
}

Be strict but fair in grading. If unsure, mark as incorrect.`;

    // Step 1: Create prediction
    console.log('Creating Replicate prediction...');
    const createResponse = await axios.post(
      'https://api.replicate.com/v1/predictions',
      {
        version: 'ac732df83cea7fff18b51941e8e9fbda735b91cc7312c0359f5e93e7c14f01ef',
        input: {
          image: \`data:image/jpeg;base64,\${base64Image}\`,
          prompt: prompt,
        },
      },
      {
        headers: {
          Authorization: \`Token \${process.env.REPLICATE_API_KEY}\`,
          'Content-Type': 'application/json',
        },
      }
    );

    const predictionId = createResponse.data.id;
    console.log('Prediction created:', predictionId);

    // Step 2: Poll for completion
    let prediction = createResponse.data;
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes with 5-second intervals

    while (
      (prediction.status === 'processing' || prediction.status === 'starting') &&
      attempts < maxAttempts
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
      
      const pollResponse = await axios.get(
        \`https://api.replicate.com/v1/predictions/\${predictionId}\`,
        {
          headers: {
            Authorization: \`Token \${process.env.REPLICATE_API_KEY}\`,
          },
        }
      );
      
      prediction = pollResponse.data;
      attempts++;
      console.log(\`Poll attempt \${attempts}: status = \${prediction.status}\`);
    }

    if (prediction.status !== 'succeeded') {
      throw new Error(\`Prediction failed with status: \${prediction.status}. Error: \${prediction.error}\`);
    }

    // Step 3: Parse the output
    console.log('Parsing LLaVA response...');
    const output = Array.isArray(prediction.output) 
      ? prediction.output.join('') 
      : prediction.output;
    
    console.log('Raw output:', output);

    // Extract JSON from response (handle markdown code blocks)
    let jsonMatch = output.match(/\`\`\`json\n?([\s\S]*?)\n?\`\`\`/);
    if (!jsonMatch) {
      jsonMatch = output.match(/\{[\s\S]*\}/);
    }
    
    if (!jsonMatch) {
      throw new Error('Could not extract JSON from LLaVA response');
    }

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const result = JSON.parse(jsonStr);

    console.log('Parsed result:', result);

    return {
      isCorrect: result.isCorrect,
      score: result.score || 0,
      answers: result.answers || [],
      feedback: result.feedback || 'No feedback available',
    };
  } catch (error) {
    console.error('AI verification error:', error.message);
    throw new Error(\`Failed to verify homework with AI: \${error.message}\`);
  }
}

// Helper function to remove answers from image (blur/pixelate answer areas)
async function removeAnswersFromImage(imageBuffer) {
  try {
    console.log('Processing image for practice mode...');
    
    // Create a blurred version of the image to simulate answer removal
    const processedImage = await sharp(imageBuffer)
      .blur(3)
      .toBuffer();
    
    console.log('Image processed successfully');
    return processedImage;
  } catch (error) {
    console.error('Image processing error:', error);
    throw error;
  }
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running', timestamp: new Date() });
});

// Verify homework (main endpoint for the web app)
app.post('/api/verify', upload.single('photo'), async (req, res) => {
  try {
    console.log('Received verification request');
    
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const mode = req.body.mode || 'check';
    const question = req.body.question || '';
    
    console.log('Mode:', mode, 'Question:', question);

    // Convert image to base64
    const base64Image = req.file.buffer.toString('base64');

    // Get AI verification with LLaVA
    const aiResult = await checkAnswersWithAI(base64Image, question);

    const response = {
      isCorrect: aiResult.isCorrect,
      score: aiResult.score,
      answers: aiResult.answers,
      feedback: aiResult.feedback,
    };

    // If practice mode, remove answers from image
    if (mode === 'practice') {
      console.log('Generating practice mode image...');
      const cleanedImageBuffer = await removeAnswersFromImage(req.file.buffer);
      const cleanedImageBase64 = cleanedImageBuffer.toString('base64');
      response.cleanedImage = \`data:image/jpeg;base64,\${cleanedImageBase64}\`;
    }

    res.json(response);
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: error.message || 'Failed to verify homework' });
  }
});

// Send email to parent
app.post('/api/send-email', upload.single('photo'), async (req, res) => {
  try {
    const { email, result } = req.body;

    if (!email || !result) {
      return res.status(400).json({ error: 'Missing email or result' });
    }

    const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;

    const answersHtml = (parsedResult.answers || [])
      .map(
        (answer) =>
          \`<li style="margin: 10px 0; padding: 10px; background: \${
            answer.isCorrect ? '#e8f5e9' : '#ffebee'
          }; border-radius: 5px;">
            <strong>\${answer.isCorrect ? '✓' : '✗'}</strong> \${answer.text}
          </li>\`
      )
      .join('');

    const mailOptions = {
      from: process.env.SMTP_USER,
      to: email,
      subject: '📚 Homework Verification Result',
      html: \`
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Homework Verification Result</h2>
          
          <div style="background: \${
            parsedResult.isCorrect ? '#e8f5e9' : '#ffebee'
          }; padding: 20px; border-radius: 10px; margin: 20px 0;">
            <h3 style="margin: 0; color: \${parsedResult.isCorrect ? '#2e7d32' : '#c62828'};">
              \${parsedResult.isCorrect ? '✓ CORRECT!' : '✗ NEEDS WORK'}
            </h3>
            <p style="margin: 10px 0; font-size: 24px; font-weight: bold;">
              Score: \${parsedResult.score}%
            </p>
          </div>

          <h3>Answer Check:</h3>
          <ul style="list-style: none; padding: 0;">
            \${answersHtml}
          </ul>

          <h3>Feedback:</h3>
          <p style="background: #f5f5f5; padding: 15px; border-radius: 5px; line-height: 1.6;">
            \${parsedResult.feedback}
          </p>

          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #999; font-size: 12px; text-align: center;">
            Sent from Homework Photo App
          </p>
        </div>
      \`,
    };

    await transporter.sendMail(mailOptions);
    console.log('Email sent to:', email);
    res.json({ message: 'Email sent successfully' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: 'Failed to send email: ' + error.message });
  }
});

// User registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    const result = await pool.query(
      'INSERT INTO users (email, password, role) VALUES (\$1, \$2, \$3) RETURNING id, email, role',
      [email, password, role]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// User login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE email = \$1 AND password = \$2',
      [email, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET);

    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
  console.log('Environment:', process.env.NODE_ENV);
  console.log('Database:', process.env.DATABASE_URL ? 'Connected' : 'Not configured');
  console.log('Replicate API Key:', process.env.REPLICATE_API_KEY ? 'Configured' : 'Not configured');
});
