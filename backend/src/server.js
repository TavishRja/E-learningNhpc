const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { initializeCourseStructure } = require('./services/course-structure');
const authRoutes = require('./routes/auth');
const courseRoutes = require('./routes/courses');
const otpRoutes = require('./routes/otp');
const chapterRoutes = require('./routes/chapters');
const discussionRoutes = require('./routes/discussions');

const app = express();
const frontendDir = path.join(__dirname, '..', '..', 'frontend');

app.use(cors());
app.use(express.json());
app.use(express.static(frontendDir));

app.use('/api/auth', authRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/otp', otpRoutes);
app.use('/api/chapters', chapterRoutes);
app.use('/api/discussions', discussionRoutes);

app.get('/api', (req, res) => res.json({ message: 'E-Learning API is running!' }));
app.get('/', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

const PORT = process.env.PORT || 5001;
initializeCourseStructure()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Could not initialize course sections:', err.message);
    process.exit(1);
  });
