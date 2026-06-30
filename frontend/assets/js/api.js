/* ============================================
   api.js — All backend API calls
   Shared frontend API helpers
============================================ */

const API_URL = window.LEARNHUB_CONFIG?.apiBaseUrl || 'http://localhost:5000/api';

function setStoredAuthValue(key, value) {
  const normalizedValue = value == null ? '' : String(value);
  localStorage.setItem(key, normalizedValue);
  sessionStorage.setItem(key, normalizedValue);
}

function getStoredAuthValue(key) {
  return localStorage.getItem(key) || sessionStorage.getItem(key) || '';
}

function clearStoredAuthValue(key) {
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
}

// ---- Save/get JWT token ----
function saveToken(token) {
  if (token) {
    setStoredAuthValue('lh_token', token);
  } else {
    clearStoredAuthValue('lh_token');
  }
}

function getToken() {
  return getStoredAuthValue('lh_token');
}

// ---- Check if logged in ----
function isLoggedIn() {
  return !!getToken();
}

// ---- Save user info ----
function saveUser(name, email) {
  setStoredAuthValue('lh_user_name', name || '');
  setStoredAuthValue('lh_user_email', email || '');
}

function getUserName() {
  return getStoredAuthValue('lh_user_name') || 'User';
}

// ---- Logout ----
function logout() {
  clearStoredAuthValue('lh_token');
  clearStoredAuthValue('lh_user_name');
  clearStoredAuthValue('lh_user_email');
  clearStoredAuthValue('lh_role');
}

// ============================================
//  SIGNUP — POST /api/auth/signup
// ============================================
async function apiSignup(name, email, password) {
  const res = await fetch(`${API_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password })
  });
  return res.json(); // returns { message, token, name, email } or { message: error }
}

// ============================================
//  SIGNIN — POST /api/auth/signin
// ============================================
async function apiSignin(email, password) {
  const res = await fetch(`${API_URL}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  return res.json();
}

// ============================================
//  GET COURSES — GET /api/courses
// ============================================
async function apiGetCourses() {
  const res = await fetch(`${API_URL}/courses`);
  return res.json();
}

// ============================================
//  ENROLL — POST /api/courses/enroll
// ============================================
async function apiEnroll(courseId) {
  const res = await fetch(`${API_URL}/courses/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`
    },
    body: JSON.stringify({ courseId })
  });
  return res.json();
}

// ============================================
//  GET MY COURSES — GET /api/courses/my
// ============================================
async function apiGetMyCourses() {
  const res = await fetch(`${API_URL}/courses/my`, {
    headers: { 'Authorization': `Bearer ${getToken()}` }
  });
  return res.json();
}

// Save role
function saveRole(role) {
  if (role) {
    setStoredAuthValue('lh_role', role);
  } else {
    clearStoredAuthValue('lh_role');
  }
}
function getRole() { return getStoredAuthValue('lh_role'); }

// Redirect to correct dashboard based on role
function redirectToDashboard(role) {
  if (role === 'admin') window.location.href = 'admin-dashboard.html';
  else if (role === 'tutor') window.location.href = 'tutor-courses.html';
  else window.location.href = 'student-dashboard.html';
}
