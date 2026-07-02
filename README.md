# E-Learning LMS

E-Learning LMS is a full-stack Learning Management System built with HTML, CSS, JavaScript, Node.js, Express, and MySQL. It supports role-based access for students, tutors, and admins, with course management, enrollment, discussions, file uploads, OTP verification, and certificate generation.

## Features

- User signup and signin with JWT authentication
- Role-based dashboards for student, tutor, and admin
- OTP email verification
- Tutor course creation and editing
- Admin course approval workflow
- Student course enrollment
- Course chapters, resources, and video/content uploads
- Discussion forum for course chapters
- Certificate generation
- MySQL database integration
- File upload support using Multer
- Email support using Nodemailer

## Tech Stack

**Frontend**
- HTML
- CSS
- JavaScript

**Backend**
- Node.js
- Express.js
- MySQL
- JWT
- bcryptjs
- Multer
- Nodemailer
- dotenv
## Getting Started

## 1. Clone the Repository

git clone https://github.com/Saumya6250/LearnHub-LMS.git
cd LearnHub-LMS

## 2. Install Backend Dependencies

cd backend
npm install

## 3. Create Environment File

Create a `.env` file inside the `backend` folder and add:

PORT=5000

DB_HOST=localhost
DB_USER=your_mysql_username
DB_PASSWORD=your_mysql_password
DB_NAME=your_database_name

JWT_SECRET=your_jwt_secret

## 4. Set Up MySQL Database

Create a MySQL database using the same database name added in `.env`.

Make sure your MySQL server is running before starting the backend.

## 5. Start the App

```bash
cd backend
npm start
```

This command starts both the backend API and the frontend site.

Open the app at:

http://localhost:5000

## API Base URL

The frontend currently uses:

http://localhost:5000/api

You can update it in:

frontend/assets/js/config.js

The API helper logic itself lives in:

frontend/assets/js/api.js

## Folder Structure

```text
E-Learning-LMS-main/
  backend/
    server.js
    package.json
    .env
    uploads/
    src/
      config/
      routes/
      services/
  frontend/
    assets/
      css/
      images/
      js/
    *.html
```

## Current Source Files

If your IDE still shows older tabs like `backend/routes/auth.js` or `backend/db.js`, close those tabs and reopen these current files instead:

- `backend/src/routes/auth.js`
- `backend/src/config/db.js`
- `backend/src/server.js`
- `frontend/assets/js/config.js`
- `frontend/assets/js/api.js`

## Author

Tavish Rja

GitHub: https://github.com/TavishRja/E-learningNhpc
