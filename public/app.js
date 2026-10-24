// =====================================================================
//  Common helpers, login / register, student dashboard
// =====================================================================
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('ucmsToken');
let role = sessionStorage.getItem('ucmsRole');

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && path !== '/login') logout(true);
  return { ok: res.ok, status: res.status, data };
}
const msgOf = (r) => r.data.message || r.data.error || 'Something went wrong';

function flash(text, bad) {
  const t = $('message');
  t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  clearTimeout(flash.timer); flash.timer = setTimeout(() => (t.hidden = true), 6000);
}

// ---------- tiny DOM helpers (textContent only, so data can never inject HTML) ----------
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e[k] = v; });
  kids.flat().forEach((k) => e.append(k instanceof Node ? k : document.createTextNode(k ?? '')));
  return e;
}
function table(headers, rows, emptyText = 'Nothing to show yet.') {
  const t = el('table');
  const hr = t.createTHead().insertRow();
  headers.forEach((h) => hr.appendChild(el('th', { text: h })));
  const body = t.createTBody();
  if (!rows.length) { const c = body.insertRow().insertCell(); c.colSpan = headers.length; c.textContent = emptyText; }
  rows.forEach((cells) => {
    const r = body.insertRow();
    cells.forEach((v) => { const c = r.insertCell(); if (v instanceof Node) c.appendChild(v); else c.textContent = v ?? ''; });
  });
  return t;
}
const button = (label, cls, onClick, disabled) => el('button', { type: 'button', text: label, class: cls || '', onclick: onClick, disabled: !!disabled });
const tag = (text, cls) => el('span', { class: 'tag ' + (cls || ''), text });
const show = (id, on) => ($(id).hidden = !on);
const fmtDate = (d) => new Date(d).toLocaleString();
const clear = (id) => { const b = $(id); b.innerHTML = ''; return b; };

// ---------- generic form dialog ----------
function formDialog({ title, fields, values = {}, submitLabel = 'Save', build, onSubmit }) {
  const dlg = $('dlg'), form = $('dlgForm');
  form.innerHTML = '';
  form.appendChild(el('h3', { text: title }));
  const inputs = {};
  fields.forEach((f) => {
    let input;
    if (f.type === 'select') {
      input = el('select');
      (f.options || []).forEach((o) => input.appendChild(el('option', { value: o.value, text: o.label })));
    } else if (f.type === 'textarea') {
      input = el('textarea', { rows: 3 });
    } else {
      input = el('input', { type: f.type || 'text' });
      ['min', 'max', 'step', 'maxLength'].forEach((k) => { if (f[k] !== undefined) input[k] = f[k]; });
    }
    input.name = f.name;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.disabled) input.disabled = true;
    if (values[f.name] !== undefined && values[f.name] !== null) input.value = values[f.name];
    const label = el('label', {}, f.label, input);
    if (f.hint) label.appendChild(el('small', { class: 'muted', text: f.hint }));
    form.appendChild(label);
    inputs[f.name] = input;
  });
  const extra = build ? build(form, inputs) : null;
  const err = el('p', { class: 'error' });
  form.append(err, el('div', { class: 'row end' },
    button('Cancel', 'ghost-dark', () => dlg.close()), el('button', { type: 'submit', text: submitLabel })));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    Object.keys(inputs).forEach((k) => { data[k] = inputs[k].value; });
    if (extra) Object.assign(data, extra());
    const problem = await onSubmit(data);
    if (problem) err.textContent = problem; else dlg.close();
  };
  dlg.showModal();
  return { inputs, form };
}

// ---------- tabs ----------
function wireTabs(group, prefix, onShow) {
  const buttons = document.querySelectorAll(`.tabs[data-group="${group}"] button`);
  const names = [...buttons].map((b) => b.dataset.tab);
  buttons.forEach((b) => {
    b.onclick = () => {
      buttons.forEach((x) => x.classList.toggle('active', x === b));
      names.forEach((n) => show(prefix + n, n === b.dataset.tab));
      if (onShow) onShow(b.dataset.tab);
    };
  });
}

// =====================================================================
//  LOGIN / REGISTER / LOGOUT
// =====================================================================
document.querySelectorAll('#authTabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#authTabs button').forEach((x) => x.classList.toggle('active', x === b));
    show('loginForm', b.dataset.auth === 'login'); show('registerForm', b.dataset.auth === 'register');
    if (b.dataset.auth === 'register') loadDepartments();
  };
});

async function loadDepartments() {
  if ($('regDept').options.length) return;
  const r = await api('/departments');
  $('regDept').appendChild(el('option', { value: '', text: 'Choose department' }));
  (r.data || []).forEach((d) => $('regDept').appendChild(el('option', { value: d.id, text: `${d.name} (${d.code})` })));
}

$('regRole').onchange = () => {
  const student = $('regRole').value === 'STUDENT';
  show('studentFields', student); show('facultyFields', !student);
  $('regPrn').required = student; $('regStaffCode').required = !student;
};
$('regPrn').required = true;

function afterAuth(data) {
  token = data.token; role = data.role;
  sessionStorage.setItem('ucmsToken', token); sessionStorage.setItem('ucmsRole', role); sessionStorage.setItem('ucmsName', data.name);
  startApp();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  const r = await api('/login', 'POST', { email: $('email').value, password: $('password').value });
  if (!r.ok) { $('loginError').textContent = msgOf(r); return; }
  afterAuth(r.data);
});

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('registerError'); err.textContent = '';
  if ($('regPassword').value !== $('regPassword2').value) { err.textContent = 'The two passwords do not match'; return; }
  const body = {
    role: $('regRole').value, name: $('regName').value, email: $('regEmail').value, password: $('regPassword').value,
    phone: $('regPhone').value.trim(), deptId: $('regDept').value
  };
  if (body.role === 'STUDENT') Object.assign(body, { prn: $('regPrn').value, yearOfStudy: $('regYear').value, address: $('regAddress').value });
  else Object.assign(body, { designation: $('regDesignation').value, staffCode: $('regStaffCode').value });
  const r = await api('/register', 'POST', body);
  if (!r.ok) { err.textContent = msgOf(r); return; }
  afterAuth(r.data);
});

async function logout(expired) {
  if (token && !expired) await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  token = null; role = null; sessionStorage.clear();
  show('appView', false); show('authView', true); $('password').value = '';
  if (expired) $('loginError').textContent = 'Your session expired. Please log in again.';
}
$('logoutBtn').onclick = () => logout(false);

// =====================================================================
//  STUDENT
// =====================================================================
async function loadSummary() {
  const r = await api('/me/summary');
  if (!r.ok) return;
  const s = clear('summary');
  const stat = (label, value, bad) => el('div', { class: 'stat' + (bad ? ' bad' : '') }, el('b', { text: value }), label);
  s.append(stat('PRN', r.data.prn), stat('CGPA', r.data.cgpa.toFixed(2), r.data.probation),
    stat('Academic standing', r.data.probation ? 'On probation' : 'Good standing', r.data.probation),
    stat('Contact details', r.data.verified ? 'Verified' : 'Not verified', !r.data.verified));
  renderVerifyBanner(r.data.verified);
}

function renderVerifyBanner(verified) {
  const box = clear('verifyBanner');
  if (verified) return;
  const code = el('input', { inputMode: 'numeric', maxLength: 6, placeholder: '6-digit code' });
  const confirmBtn = button('Confirm', '', async () => {
    const r = await api('/me/verify/confirm', 'POST', { code: code.value });
    flash(msgOf(r), !r.ok);
    if (r.ok) refreshStudent();
  });
  const sendBtn = button('Send me a code', 'alt', async () => {
    const r = await api('/me/verify/request', 'POST');
    flash(msgOf(r), !r.ok); loadNotes('tab-notes');
  });
  box.appendChild(el('div', { class: 'banner' },
    el('strong', { text: 'Verify your contact details to enroll in courses' }),
    el('span', { text: 'We send a 6-digit code to your registered contact. In this demo it appears in your Notifications tab.' }),
    el('div', { class: 'row' }, sendBtn, code, confirmBtn)));
}

async function loadSections() {
  const r = await api('/sections');
  const box = clear('tab-sections');
  box.appendChild(table(['Course', 'Title', 'Type', 'Sec', 'Faculty', 'Room', 'Time', 'Seats', ''],
    r.data.map((s) => [
      s.code, s.title, s.type, s.section, s.faculty, s.room, s.slot,
      tag(s.seatsLeft > 0 ? `${s.seatsLeft} left` : 'Full', s.seatsLeft > 0 ? '' : 'full'),
      button(s.seatsLeft > 0 ? 'Enroll' : 'Join waitlist', s.seatsLeft > 0 ? '' : 'alt', async () => {
        const res = await api('/enroll', 'POST', { sectionId: s.id });
        flash(msgOf(res), !res.ok); refreshStudent();
      })])));
}

async function loadMine() {
  const r = await api('/me/enrollments');
  const box = clear('tab-mine');
  box.appendChild(table(['Course', 'Title', 'Type', 'Sec', 'Time', 'Status', 'Grade', ''],
    r.data.map((e) => [e.code, e.title, e.type, e.section, e.slot, e.status, e.grade || '-',
      e.status === 'Enrolled' ? button('Drop', 'warn', async () => {
        if (!confirm('Drop ' + e.code + '?')) return;
        const res = await api('/drop', 'POST', { enrollmentId: e.id });
        flash(msgOf(res), !res.ok); refreshStudent();
      }) : ''])));
}

async function loadTasks() {
  const r = await api('/me/tasks');
  const box = clear('tab-tasks');
  box.appendChild(el('p', { class: 'muted', text: 'Finish the tasks for a course before you enroll in it. Assignments must be approved by faculty; videos must be marked as watched.' }));
  if (!r.data.length) box.appendChild(el('div', { class: 'card', text: 'No prerequisite tasks have been set.' }));
  r.data.forEach((t) => {
    const statusCls = t.done ? 'ok' : t.status === 'Rejected' ? 'bad' : '';
    const card = el('div', { class: 'task' + (t.done ? ' done' : '') },
      el('h3', { text: `${t.code} - ${t.title}` }),
      el('div', { class: 'meta', text: `${t.type} | needed for: ${t.appliesTo === 'Both' ? 'Theory and Lab' : t.appliesTo} | ${t.courseTitle}` }),
      t.description ? el('div', { text: t.description }) : '',
      el('div', {}, tag(t.status, statusCls)));
    if (t.remarks && t.status === 'Rejected') card.appendChild(el('div', { class: 'remarks', text: 'Faculty remarks: ' + t.remarks }));
    if (t.type === 'Video') {
      if (/^https?:\/\//i.test(t.videoUrl || '')) card.appendChild(el('a', { href: t.videoUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open the video' }));
      if (!t.done) card.appendChild(el('div', {}, button('I have watched this video', '', async () => {
        const res = await api(`/me/tasks/${t.id}/watched`, 'POST'); flash(msgOf(res), !res.ok); loadTasks();
      })));
    } else if (t.status !== 'Approved') {
      const ta = el('textarea', { rows: 4, placeholder: 'Write your answer here (at least 10 characters)', maxLength: 5000, value: t.content || '' });
      card.append(ta, el('div', {}, button(t.status === 'Not started' ? 'Submit assignment' : 'Resubmit', '', async () => {
        const res = await api(`/me/tasks/${t.id}/submit`, 'POST', { content: ta.value }); flash(msgOf(res), !res.ok); loadTasks();
      })));
    }
    box.appendChild(card);
  });
}

async function loadAttendance() {
  const r = await api('/me/attendance');
  const box = clear('tab-attendance');
  box.appendChild(el('p', { class: 'muted', text: 'Attendance counts Present and Late as attended. 75% or more is the usual requirement.' }));
  box.appendChild(table(['Course', 'Type', 'Sec', 'Present', 'Late', 'Absent', 'Classes', 'Attendance', 'Recent'],
    r.data.map((a) => [a.code, a.type, a.section, a.present, a.late, a.absent, a.total,
      a.percent === null ? 'No classes yet' : el('span', {}, el('progress', { max: 100, value: a.percent }), ` ${a.percent}% `, a.low ? tag('Low', 'bad') : ''),
      a.recent.map((x) => `${x.date.slice(5)} ${x.status[0]}`).join(', ')]),
    'You are not enrolled in any course this semester.'));
}

async function loadNotes(targetId, markRead) {
  const r = await api('/notifications');
  const box = clear(targetId);
  if (!r.data.length) { box.textContent = 'No notifications yet.'; return; }
  r.data.forEach((n) => box.appendChild(el('div', { class: 'note' + (n.isRead ? '' : ' unread'), text: fmtDate(n.createdAt) + ' - ' + n.message })));
  if (markRead) api('/notifications/read', 'POST');
}

async function loadCourses() {
  const r = await api('/courses');
  const box = clear('tab-courses');
  box.appendChild(table(['Code', 'Title', 'Credits', 'Prerequisites', 'Description'],
    r.data.map((c) => [c.code, c.title, c.credits, c.prerequisites.join(', ') || 'None', c.description])));
}

function refreshStudent() { loadSummary(); loadSections(); loadMine(); loadTasks(); loadAttendance(); loadNotes('tab-notes'); }
