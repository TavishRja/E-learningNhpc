/* ============================================
   script.js — UI logic (uses api.js for backend calls)
   Load api.js before this file on every page
============================================ */

const ALLOWED_DOMAIN = '@gmail.com';
const FLASH_TOAST_KEY = 'lh_flash_toast';

function showToast(message, type = '') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 3000);
}

function queueToast(message, type = '') {
  sessionStorage.setItem(FLASH_TOAST_KEY, JSON.stringify({ message, type }));
}

function showQueuedToast() {
  const raw = sessionStorage.getItem(FLASH_TOAST_KEY);
  if (!raw) return;
  sessionStorage.removeItem(FLASH_TOAST_KEY);
  try {
    const toast = JSON.parse(raw);
    if (toast?.message) showToast(toast.message, toast.type || '');
  } catch {
    // Ignore malformed session toast payloads.
  }
}

function showPopup(icon, title, message, btnText = 'OK', onClose = null) {
  const overlay = document.getElementById('popup-overlay');
  if (!overlay) return;
  overlay.querySelector('.popup-icon').textContent = icon;
  overlay.querySelector('h3').textContent = title;
  overlay.querySelector('p').textContent = message;
  overlay.querySelector('.popup-close-btn').textContent = btnText;
  overlay.classList.add('show');
  overlay.querySelector('.popup-close-btn').onclick = () => { overlay.classList.remove('show'); if (onClose) onClose(); };
  overlay.onclick = (e) => { if (e.target === overlay) { overlay.classList.remove('show'); if (onClose) onClose(); } };
}

function updateNavbar() {
  const navSignin    = document.getElementById('nav-signin');
  const navSignup    = document.getElementById('nav-signup');
  const navUser      = document.getElementById('nav-user');
  const navLogout    = document.getElementById('nav-logout');
  const navDashboard = document.getElementById('nav-dashboard');

  if (isLoggedIn()) {
    if (navSignin)    navSignin.style.display    = 'none';
    if (navSignup)    navSignup.style.display    = 'none';
    if (navUser)    { navUser.style.display      = 'inline'; navUser.textContent = '👤 ' + getUserName(); }
    if (navLogout)    navLogout.style.display    = 'inline';
    if (navDashboard) navDashboard.style.display = 'inline';
  } else {
    if (navSignin)    navSignin.style.display    = 'inline';
    if (navSignup)    navSignup.style.display    = 'inline';
    if (navUser)      navUser.style.display      = 'none';
    if (navLogout)    navLogout.style.display    = 'none';
    if (navDashboard) navDashboard.style.display = 'none';
  }
}

function initSignIn() {
  const form = document.getElementById('signin-form');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearErrors();
    const email    = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email) { showFieldError('email-error', 'Email is required.'); return; }
    if (!email.endsWith(ALLOWED_DOMAIN)) { showPopup('🚫', 'Access Restricted', `Only ${ALLOWED_DOMAIN} emails are allowed.`); return; }
    if (!password) { showFieldError('password-error', 'Password is required.'); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.textContent = 'Signing in...'; btn.disabled = true;
    const data = await apiSignin(email, password);
    btn.textContent = 'Login'; btn.disabled = false;
    if (data.token) {
      saveToken(data.token); saveUser(data.name, data.email);
      saveRole(data.role);
      showToast('Signed in!', 'success');
      redirectToDashboard(data.role);
    } else {
      showPopup('❌', 'Sign In Failed', data.message || 'Invalid credentials.');
    }
  });
}

function initSignUp() {
  const form = document.getElementById('signup-form');
  if (!form) return;
  if (form.dataset.signupMode === 'otp') return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearErrors();
    const name     = document.getElementById('name').value.trim();
    const email    = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirm  = document.getElementById('confirm-password').value;
    //const terms    = document.getElementById('terms').checked;
    let valid = true;
    if (!name)                             { showFieldError('name-error', 'Name is required.'); valid = false; }
    if (!email)                            { showFieldError('email-error', 'Email is required.'); valid = false; }
    else if (!email.endsWith(ALLOWED_DOMAIN)) { showPopup('🚫', 'Access Restricted', `Only ${ALLOWED_DOMAIN} emails are allowed.`); return; }
    if (!password || password.length < 6) { showFieldError('password-error', 'Min 6 characters.'); valid = false; }
    if (password !== confirm)              { showFieldError('confirm-error', 'Passwords do not match.'); valid = false; }
    //if (!terms)                            { showFieldError('terms-error', 'Please agree to Terms.'); valid = false; }
    if (!valid) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.textContent = 'Creating account...'; btn.disabled = true;
    const data = await apiSignup(name, email, password);
    btn.textContent = 'Sign Up'; btn.disabled = false;
    if (data.token) {
      saveToken(data.token); saveUser(data.name, data.email);
      showToast('Account created!', 'success');
      setTimeout(() => window.location.href = 'index.html', 1000);
    } else {
      showPopup('❌', 'Sign Up Failed', data.message || 'Something went wrong.');
    }
  });
}

function getCourseImageUrl(course) {
  return course?.image_path
    ? `${API_URL}/courses/${course.id}/image`
    : 'assets/images/course-placeholder.svg';
}

function escapeCourseText(value) {
  const element = document.createElement('div');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

function courseDescriptionText(value) {
  const element = document.createElement('div');
  element.innerHTML = String(value || '');
  return element.textContent.trim();
}

function sanitizeCourseDescriptionHtml(value) {
  const allowedTags = new Set([
    'B', 'STRONG', 'I', 'EM', 'U', 'S', 'P', 'DIV', 'BR', 'SPAN',
    'H1', 'H2', 'H3', 'BLOCKQUOTE', 'OL', 'UL', 'LI', 'A'
  ]);
  const template = document.createElement('template');
  template.innerHTML = String(value || '');

  template.content.querySelectorAll('*').forEach((element) => {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      return;
    }
    [...element.attributes].forEach((attribute) => {
      const allowed = (
        (element.tagName === 'A' && ['href', 'target', 'rel'].includes(attribute.name)) ||
        attribute.name === 'class' ||
        attribute.name === 'style'
      );
      if (!allowed) element.removeAttribute(attribute.name);
    });
    const safeClasses = (element.getAttribute('class') || '').split(/\s+/).filter(item =>
      /^(ql-align-(center|right|justify)|ql-font-(serif|monospace)|ql-indent-[1-8])$/.test(item)
    );
    if (safeClasses.length) element.setAttribute('class', safeClasses.join(' '));
    else element.removeAttribute('class');
    const safeStyles = (element.getAttribute('style') || '').split(';').map(item => item.trim()).filter(item =>
      /^(color|background-color):\s*(#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|[a-z]+)$/i.test(item)
    );
    if (safeStyles.length) element.setAttribute('style', safeStyles.join(';'));
    else element.removeAttribute('style');
    if (element.tagName === 'A' && !/^(https?:|mailto:)/i.test(element.getAttribute('href') || '')) {
      element.removeAttribute('href');
    }
  });

  return template.innerHTML;
}

async function loadHomepageCourses() {
  const container = document.getElementById('homepage-courses');
  if (!container) return;
  try {
    const courses = await apiGetCourses();
    if (!Array.isArray(courses)) throw new Error(courses.message || 'Could not load courses.');
    if (!courses.length) {
      container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:36px;">No published courses are available yet.</div>';
      return;
    }

    container.innerHTML = courses.map(course => {
      const lectureCount = Number(course.chapter_count || 0);
      return `
        <article class="course-card">
          <div class="card-img">
            <img src="${getCourseImageUrl(course)}" alt="${escapeCourseText(course.title)}" onerror="this.src='assets/images/course-placeholder.svg'" />
          </div>
          <div class="card-body">
            <div class="card-title">${escapeCourseText(course.title)}</div>
            <div class="card-desc">${escapeCourseText(courseDescriptionText(course.description) || 'Course details will be added soon.')}</div>
            <div class="card-meta">
              <span>${lectureCount} lecture${lectureCount === 1 ? '' : 's'}</span>
              <span>${escapeCourseText(course.tutor_name || 'E-Learning Tutor')}</span>
            </div>
            <button class="btn btn-primary" onclick="viewCourse(${course.id})">View Course</button>
          </div>
        </article>
      `;
    }).join('');
  } catch (error) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#9f3434;padding:36px;">${escapeCourseText(error.message)}</div>`;
  }
}

function initLogout() {
  const btn = document.getElementById('nav-logout');
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    e.preventDefault(); logout();
    showToast('Logged out.');
    setTimeout(() => window.location.href = 'index.html', 800);
  });
}

function initSearch() {
  const searchBtn   = document.getElementById('search-btn');
  const searchInput = document.getElementById('search-input');
  if (!searchBtn || !searchInput) return;
  searchBtn.addEventListener('click', function () {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) return;
    document.querySelectorAll('.course-card').forEach(card => {
      const match = card.querySelector('.card-title').textContent.toLowerCase().includes(query)
                 || card.querySelector('.card-desc').textContent.toLowerCase().includes(query);
      card.style.opacity   = match ? '1' : '0.4';
      card.style.outline   = match ? '2px solid var(--accent)' : 'none';
      card.style.transform = match ? 'translateY(-4px)' : '';
    });
    document.getElementById('courses-section')?.scrollIntoView({ behavior: 'smooth' });
  });
  searchInput.addEventListener('input', function () {
    if (!this.value) document.querySelectorAll('.course-card').forEach(c => { c.style.opacity=''; c.style.outline=''; c.style.transform=''; });
  });
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });
}

function showFieldError(id, msg) { const el = document.getElementById(id); if (!el) return; el.textContent = msg; el.style.display = 'block'; }
function clearErrors() { document.querySelectorAll('.field-error').forEach(el => { el.style.display = 'none'; el.textContent = ''; }); }
function viewCourse(courseId) { window.location.href = `course-details.html?courseId=${Number(courseId)}`; }

document.addEventListener('DOMContentLoaded', function () {
  showQueuedToast();
  updateNavbar();
  initSignIn();
  initSignUp();
  initLogout();
  initSearch();
  loadHomepageCourses();
});
