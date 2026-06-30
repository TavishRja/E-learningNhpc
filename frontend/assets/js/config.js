const isFilePreview = window.location.protocol === 'file:';
const defaultApiBaseUrl = isFilePreview
  ? 'http://localhost:5000/api'
  : `${window.location.origin}/api`;

window.LEARNHUB_CONFIG = {
  apiBaseUrl: defaultApiBaseUrl
};
