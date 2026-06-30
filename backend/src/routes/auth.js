// routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../config/db');
require('dotenv').config();

const router = express.Router();
const ALLOWED_DOMAIN = '@gmail.com';

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!email.endsWith(ALLOWED_DOMAIN))
    return res.status(400).json({ message: 'Only organization emails are allowed.' });

  db.query('SELECT * FROM otps WHERE email = ? AND verified = TRUE', [email], async (err, otpResults) => {
    if (err) return res.status(500).json({ message: 'Database error.' });
    if (otpResults.length === 0)
      return res.status(400).json({ message: 'Email not verified. Please verify OTP first.' });

    db.query('SELECT id FROM users WHERE email = ?', [email], async (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      if (results.length > 0)
        return res.status(400).json({ message: 'Email already registered.' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const userRole = role === 'tutor' ? 'tutor' : 'student'; // only student or tutor on signup

      db.query(
        'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
        [name, email, hashedPassword, userRole],
        (err, result) => {
          if (err) return res.status(500).json({ message: 'Could not create user.' });
          db.query('DELETE FROM otps WHERE email = ?', [email]);
          const token = jwt.sign(
            { userId: result.insertId, name, email, role: userRole },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
          );
          res.status(201).json({ message: 'Account created!', token, name, email, role: userRole });
        }
      );
    });
  });
});

// POST /api/auth/signin
router.post('/signin', (req, res) => {
  const { email, password } = req.body;

  if (!email.endsWith(ALLOWED_DOMAIN))
    return res.status(400).json({ message: 'Only organization emails are allowed.' });

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error.' });
    if (results.length === 0)
      return res.status(401).json({ message: 'Invalid email or password.' });

    const user = results[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ message: 'Invalid email or password.' });

    const token = jwt.sign(
      { userId: user.id, name: user.name, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ message: 'Signed in!', token, name: user.name, email: user.email, role: user.role });
  });
});

// GET /api/auth/users — admin only
const jwt2 = require('jsonwebtoken');
router.get('/users', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Not logged in.' });
  try {
    const user = jwt2.verify(token, process.env.JWT_SECRET);
    if (user.role !== 'admin') return res.status(403).json({ message: 'Access denied.' });
    db.query('SELECT id,name,email,role,created_at FROM users', (err, results) => {
      if (err) return res.status(500).json({ message: 'Database error.' });
      res.json(results);
    });
  } catch { res.status(401).json({ message: 'Invalid token.' }); }
});

module.exports = router;
