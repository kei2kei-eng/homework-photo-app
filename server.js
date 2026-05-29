const express = require('express');
const multer = require('multer');
const axios = require('axios');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
// Updated to current working LLaVA model version
const LLAVA_MODEL_VERSION = 'llava-hf/llava-v1.6-mistral-7b';

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Call Replicate API with polling
 */
async function callReplicateAPI(imageBase64, prompt) {
  try {
    console.log('Calling Replicate API with prompt length:', prompt.length);
    
    // Create prediction
    const createResponse = await axios.post(
      'https://api.replicate.com/v1/predictions',
      {
        version: LLAVA_MODEL_VERSION,
        input: {
          image: `data:image/jpeg;base64,${imageBase64}`,
          prompt: prompt,
        },
      },
      {
        headers: {
          Authorization: `Token ${REPLICATE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const predictionId = createResponse.data.id;
    console.log('Prediction created:', predictionId);
    let prediction = createResponse.data;
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes with 5-second intervals

    // Poll for completion
    while (
      (prediction.status === 'processing' || prediction.status === 'starting') &&
      attempts < maxAttempts
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const pollResponse = await axios.get(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        {
          headers: {
            Authorization: `Token ${REPLICATE_API_KEY}`,
          },
        }
      );

      prediction = pollResponse.data;
      attempts++;
      console.log(`Poll attempt ${attempts}: status = ${prediction.status}`);
    }

    if (prediction.status !== 'succeeded') {
      console.error('Prediction failed with status:', prediction.status);
      console.error('Error details:', prediction.error);
      throw new Error(`Replicate API failed: ${prediction.status} - ${prediction.error || 'Unknown error'}`);
    }

    const output = Array.isArray(prediction.output)
      ? prediction.output.join('')
      : prediction.output;

    console.log('Replicate API output length:', output.length);
    return output;
  } catch (error) {
    console.error('Replicate API error:', error.message);
    throw error;
  }
}

/**
 * Extract JSON from text response - More robust version
 */
function extractJSON(text) {
  try {
    console.log('Attempting to extract JSON from text of length:', text.length);
    
    // Try to find JSON in code blocks first
    let jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      console.log('Found JSON in code block');
      return JSON.parse(jsonMatch[1]);
    }

    // Try to find raw JSON object
    jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      console.log('Found JSON object');
      return JSON.parse(jsonMatch[0]);
    }

    // Try to parse the entire text
    console.log('Parsing entire text as JSON');
    return JSON.parse(text);
  } catch (error) {
    console.error('JSON extraction error:', error.message);
    console.error('Text that failed to parse:', text.substring(0, 500));
    throw new Error('Could not extract valid JSON from response');
  }
}

/**
 * Check homework answers with AI
 */
async function checkAnswersWithAI(imageBase64, userAnswers) {
  const prompt = `You are a homework grading assistant. Analyze this homework image and verify the student's answers.

Student's answers:
${userAnswers.map((answer, i) => `${i + 1}. ${answer}`).join('\n')}

For each answer, provide:
1. Whether it's correct (true/false)
2. A score from 0-100
3. Detailed feedback

Return ONLY a valid JSON object with NO markdown formatting:
{
  "results": [
    {
      "questionNumber": 1,
      "isCorrect": true,
      "score": 100,
      "feedback": "Correct! Your answer is accurate."
    }
  ],
  "totalScore": 100,
  "overallFeedback": "Great job on this homework!"
}`;

  const output = await callReplicateAPI(imageBase64, prompt);
  return extractJSON(output);
}

/**
 * Extract quiz from image
 */
async function extractQuizFromImage(imageBase64) {
  const prompt = `You are a homework analysis assistant. Analyze this homework image and extract all questions/problems visible.

For each question, identify:
1. The question text
2. The type (multiple_choice, short_answer, or calculation)
3. Any available options (if multiple choice)

Return ONLY a valid JSON object with NO markdown formatting:
{
  "questions": [
    {
      "id": 1,
      "text": "question text here",
      "type": "multiple_choice",
      "options": ["option1", "option2", "option3", "option4"]
    }
  ],
  "totalQuestions": 5,
  "difficulty": "medium"
}`;

  const output = await callReplicateAPI(imageBase64, prompt);
  return extractJSON(output);
}

/**
 * Verify quiz answers
 */
async function verifyQuizAnswers(imageBase64, questions, userAnswers) {
  const answersText = userAnswers
    .map((answer, i) => `Question ${i + 1}: ${answer}`)
    .join('\n');

  const prompt = `You are a homework grading assistant. Verify these quiz answers based on the homework image.

Questions:
${questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')}

Student's answers:
${answersText}

For each answer, provide:
1. Whether it's correct
2. A score from 0-100
3. Detailed feedback

Return ONLY a valid JSON object with NO markdown formatting:
{
  "results": [
    {
      "questionId": 1,
      "isCorrect": true,
      "score": 100,
      "feedback": "Correct answer!"
    }
  ],
  "totalScore": 100,
  "overallFeedback": "Excellent work!"
}`;

  const output = await callReplicateAPI(imageBase64, prompt);
  return extractJSON(output);
}

// ==================== AUTHENTICATION ENDPOINTS ====================

/**
 * User Registration
 */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // In production, save to database
    const user = {
      id: Date.now().toString(),
      email,
      name,
      password: hashedPassword,
    };

    res.json({
      success: true,
      message: 'User registered successfully',
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * User Login
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing email or password' });
    }

    // In production, fetch from database
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { email },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ==================== HOMEWORK VERIFICATION ENDPOINTS ====================

/**
 * Verify Homework
 */
app.post('/api/verify', upload.single('photo'), async (req, res) => {
  try {
    console.log('Received homework verification request');

    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });
    }

    const { answers } = req.body;
    if (!answers) {
      return res.status(400).json({ error: 'No answers provided' });
    }

    const userAnswers = Array.isArray(answers) ? answers : [answers];
    const imageBase64 = req.file.buffer.toString('base64');

    const verification = await checkAnswersWithAI(imageBase64, userAnswers);

    res.json({
      success: true,
      verification,
      imageBase64: `data:image/jpeg;base64,${imageBase64}`,
    });
  } catch (error) {
    console.error('Homework verification error:', error);
    res.status(500).json({ error: error.message || 'Verification failed' });
  }
});

// ==================== QUIZ ENDPOINTS ====================

/**
 * Extract Quiz from Image
 */
app.post('/api/extract-quiz', upload.single('photo'), async (req, res) => {
  try {
    console.log('Received quiz extraction request');

    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });
    }

    const imageBase64 = req.file.buffer.toString('base64');
    console.log('Image size:', imageBase64.length, 'bytes');
    
    const quiz = await extractQuizFromImage(imageBase64);

    res.json({
      success: true,
      quiz,
      imageBase64: `data:image/jpeg;base64,${imageBase64}`,
    });
  } catch (error) {
    console.error('Quiz extraction error:', error);
    res.status(500).json({ error: error.message || 'Failed to extract quiz' });
  }
});

/**
 * Verify Quiz Answers
 */
app.post('/api/verify-quiz-answers', async (req, res) => {
  try {
    console.log('Received quiz answer verification request');

    const { questions, answers, imageBase64 } = req.body;

    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Invalid questions format' });
    }

    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Invalid answers format' });
    }

    if (!imageBase64) {
      return res.status(400).json({ error: 'No image provided' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });
    }

    // Extract base64 from data URL if needed
    const base64Image = imageBase64.includes('base64,')
      ? imageBase64.split('base64,')[1]
      : imageBase64;

    const verification = await verifyQuizAnswers(base64Image, questions, answers);

    res.json({
      success: true,
      verification,
    });
  } catch (error) {
    console.error('Quiz answer verification error:', error);
    res.status(500).json({ error: error.message || 'Failed to verify answers' });
  }
});

/**
 * Get Quiz Report
 */
app.post('/api/get-quiz-report', async (req, res) => {
  try {
    console.log('Received quiz report request');

    const { quiz, verification, imageBase64 } = req.body;

    if (!quiz || !verification) {
      return res.status(400).json({ error: 'Missing quiz or verification data' });
    }

    const report = {
      timestamp: new Date().toISOString(),
      totalQuestions: quiz.totalQuestions || 0,
      totalScore: verification.totalScore || 0,
      difficulty: quiz.difficulty || 'unknown',
      results: verification.results || [],
      overallFeedback: verification.overallFeedback || 'No feedback available',
      passRate: verification.totalScore >= 70 ? 'Pass' : 'Needs Improvement',
    };

    res.json({
      success: true,
      report,
    });
  } catch (error) {
    console.error('Quiz report error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate report' });
  }
});

// ==================== EMAIL ENDPOINTS ====================

/**
 * Send Email with Verification Results
 */
app.post('/api/send-email', async (req, res) => {
  try {
    const { parentEmail, studentName, verification, imageBase64 } = req.body;

    if (!parentEmail || !studentName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const mailOptions = {
      from: process.env.SMTP_USER,
      to: parentEmail,
      subject: `Homework Verification Report for ${studentName}`,
      html: `
        <h2>Homework Verification Report</h2>
        <p><strong>Student:</strong> ${studentName}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
        <hr>
        <h3>Results:</h3>
        <p><strong>Total Score:</strong> ${verification.totalScore || 0}/100</p>
        <p><strong>Feedback:</strong> ${verification.overallFeedback || 'No feedback'}</p>
        <hr>
        <p>Please review the attached image for more details.</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      message: 'Email sent successfully',
    });
  } catch (error) {
    console.error('Email sending error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// ==================== HEALTH CHECK ====================

/**
 * Health Check Endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    replicateConfigured: !!REPLICATE_API_KEY,
  });
});

// ==================== ERROR HANDLING ====================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Replicate API configured: ${!!REPLICATE_API_KEY}`);
});

module.exports = app;
