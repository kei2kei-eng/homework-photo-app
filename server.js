const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const multer = require('multer');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const axios = require('axios');
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

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
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

// Upload and verify homework photo
app.post('/api/homework/upload', authenticateToken, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Convert image to base64
    const base64Image = req.file.buffer.toString('base64');

    // Call Zeabur AI Hub (Claude Vision API)
    const aiResponse = await axios.post(
      'https://hnd1.aihub.zeabur.ai/v1/messages',
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
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
                text: 'Please verify if the homework answers in this image are correct. Respond with a JSON object containing: { "isCorrect": true/false, "feedback": "explanation", "score": 0-100 }',
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

    // Parse AI response
    const aiResult = JSON.parse(aiResponse.data.content[0].text);

    // Save to database
    const dbResult = await pool.query(
      'INSERT INTO homework_submissions (user_id, photo_url, is_correct, feedback, score) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, req.file.filename, aiResult.isCorrect, aiResult.feedback, aiResult.score]
    );

    res.json({ submission: dbResult.rows[0], aiVerification: aiResult });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get homework submissions
app.get('/api/homework/submissions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM homework_submissions WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    
    res.json({ submissions: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send email to parent
app.post('/api/homework/send-to-parent', authenticateToken, async (req, res) => {
  try {
    const { submissionId, parentEmail } = req.body;

    const result = await pool.query(
      'SELECT * FROM homework_submissions WHERE id = $1 AND user_id = $2',
      [submissionId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submission = result.rows[0];

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: parentEmail,
      subject: 'Homework Verification Result',
      html: `
        <h2>Homework Verification Result</h2>
        <p><strong>Status:</strong> ${submission.is_correct ? '✓ Correct' : '✗ Incorrect'}</p>
        <p><strong>Score:</strong> ${submission.score}/100</p>
        <p><strong>Feedback:</strong> ${submission.feedback}</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: 'Email sent successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove answers from photo (placeholder)
app.post('/api/homework/remove-answers', authenticateToken, upload.single('photo'), async (req, res) => {
  try {
    // This would require image processing library like sharp or PIL
    // For now, returning a placeholder response
    res.json({ message: 'Answer removal feature coming soon', originalPhoto: req.file.filename });
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
