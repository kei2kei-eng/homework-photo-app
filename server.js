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
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Multer setup for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD,
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

// Helper function to check individual answers using Claude Vision
async function checkAnswersWithAI(base64Image) {
  try {
    const aiResponse = await axios.post(
      'https://hnd1.aihub.zeabur.ai/v1/messages',
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: `Please analyze this homework image and verify each answer. 
                
                Return a JSON object with this exact structure:
                {
                  "correct": true/false,
                  "score": 0-100,
                  "answers": [
                    {
                      "text": "Answer text or question",
                      "correct": true/false
                    }
                  ],
                  "feedback": "Overall feedback about the homework"
                }
                
                For each visible answer or question, add an entry to the answers array.
                Mark as correct (true) or incorrect (false).
                Calculate overall score as percentage of correct answers.`,
              },
            ],
          },
        ],
      },
      {
        headers: {
          'x-api-key': process.env.AI_HUB_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const responseText = aiResponse.data.content[0].text;
    
    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse AI response');
    }
    
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI verification error:', error);
    throw error;
  }
}

// Helper function to remove answers from image (blur/pixelate answer areas)
async function removeAnswersFromImage(imageBuffer) {
  try {
    // Create a blurred version of the image to simulate answer removal
    // This is a simple approach - in production, you might use more sophisticated techniques
    const processedImage = await sharp(imageBuffer)
      .blur(2) // Slight blur to simulate answer removal
      .toBuffer();
    
    return processedImage;
  } catch (error) {
    console.error('Image processing error:', error);
    throw error;
  }
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

// Verify homework (main endpoint for the web app)
app.post('/api/verify', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const mode = req.body.mode || 'check';
    const base64Image = req.file.buffer.toString('base64');

    // Get AI verification with individual answer checks
    const aiResult = await checkAnswersWithAI(base64Image);

    const response = {
      correct: aiResult.correct,
      score: aiResult.score,
      answers: aiResult.answers || [],
      feedback: aiResult.feedback,
    };

    // If practice mode, remove answers from image
    if (mode === 'practice') {
      const cleanedImageBuffer = await removeAnswersFromImage(req.file.buffer);
      const cleanedImageBase64 = cleanedImageBuffer.toString('base64');
      response.cleaned_image = `data:image/jpeg;base64,${cleanedImageBase64}`;
    }

    res.json(response);
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Failed to verify homework' });
  }
});

// Send email to parent
app.post('/api/send-email', upload.single('photo'), async (req, res) => {
  try {
    const { email, result } = req.body;

    if (!email || !result) {
      return res.status(400).json({ error: 'Missing email or result' });
    }

    const answersHtml = result.answers
      .map(
        (answer) =>
          `<li style="margin: 10px 0; padding: 10px; background: ${
            answer.correct ? '#e8f5e9' : '#ffebee'
          }; border-radius: 5px;">
            <strong>${answer.correct ? '✓' : '✗'}</strong> ${answer.text}
          </li>`
      )
      .join('');

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: '📚 Homework Verification Result',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Homework Verification Result</h2>
          
          <div style="background: ${
            result.correct ? '#e8f5e9' : '#ffebee'
          }; padding: 20px; border-radius: 10px; margin: 20px 0;">
            <h3 style="margin: 0; color: ${result.correct ? '#2e7d32' : '#c62828'};">
              ${result.correct ? '✓ CORRECT!' : '✗ NEEDS WORK'}
            </h3>
            <p style="margin: 10px 0; font-size: 24px; font-weight: bold;">
              Score: ${result.score}%
            </p>
          </div>

          <h3>Answer Check:</h3>
          <ul style="list-style: none; padding: 0;">
            ${answersHtml}
          </ul>

          <h3>Feedback:</h3>
          <p style="background: #f5f5f5; padding: 15px; border-radius: 5px; line-height: 1.6;">
            ${result.feedback}
          </p>

          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #999; font-size: 12px; text-align: center;">
            Sent from Homework Photo App
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: 'Email sent successfully' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// User registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    const result = await pool.query(
      'INSERT INTO users (email, password, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email, password, role]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND password = $2',
      [email, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET);

    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
