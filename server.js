require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const makeServices = require('./services');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(express.static('public'));

const sessions = new Map();                 // token -> { userId, role, refId, email, name, last }
const IDLE_MS = 30 * 60 * 1000;             // 30-minute inactivity expiry (SRS)
const verifyCodes = new Map();              // studentId -> { code, expires, tries }
const loginFails = new Map();               // email -> { count, first }

let db, svc;
const C = (n) => db.collection(n);
const bad = (res, message, code = 400) => res.status(code).json({ ok: false, error: message, message });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  if (e && e.code === 11000) return bad(res, 'That value already exists (duplicate).', 409);
  if (e && e.code === 121) return bad(res, 'The data did not pass database validation.', 400);
  bad(res, 'Server error', 500);
});

// ---------- passwords (bcrypt; old SHA-256 hashes are upgraded on first login) ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isLegacyHash = (h) => /^[0-9a-f]{64}$/.test(h);
const hashPassword = (pw) => bcrypt.hash(pw, 10);
async function checkPassword(user, pw) {
  if (isLegacyHash(user.passwordHash)) {
    const a = Buffer.from(sha256(pw)), b = Buffer.from(user.passwordHash);
    if (!crypto.timingSafeEqual(a, b)) return false;
    await C('users').updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(pw) } });
    return true;
  }
  return bcrypt.compare(pw, user.passwordHash);
}

// ---------- sessions ----------
function auth(roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const s = sessions.get(token);
    if (!s || Date.now() - s.last > IDLE_MS) { sessions.delete(token); return bad(res, 'Please log in again', 401); }
    if (roles && !roles.includes(s.role)) return bad(res, 'Access denied for your role', 403);
    s.last = Date.now();
    req.user = s;
    next();
  };
}
function startSession(user, name) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user._id, role: user.role, refId: user.roleRefId, email: user.email, name, last: Date.now() });
  return { token, role: user.role, name };
}
setInterval(() => { for (const [t, s] of sessions) if (Date.now() - s.last > IDLE_MS) sessions.delete(t); }, 10 * 60 * 1000).unref();

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
function parseDay(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(str + 'T00:00:00Z');
  return isNaN(d) || d.toISOString().slice(0, 10) !== str ? null : d;
}

// =====================================================================
//  PUBLIC: departments, register, login
// =====================================================================
app.get('/api/departments', wrap(async (req, res) => {
  res.json((await C('departments').find().sort({ deptName: 1 }).toArray()).map((d) => ({ id: d._id, name: d.deptName, code: d.deptCode })));
}));

app.post('/api/register', wrap(async (req, res) => {
  const b = req.body || {};
  const role = b.role;
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const phone = b.phone ? String(b.phone).trim() : null;
  const deptId = Number(b.deptId);

  if (!['STUDENT', 'FACULTY'].includes(role)) return bad(res, 'Choose Student or Faculty');
  if (name.length < 2 || name.length > 100) return bad(res, 'Enter your full name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return bad(res, 'Enter a valid email address');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return bad(res, 'Password must be at least 8 characters with a letter and a digit');
  if (phone && !/^\+?\d{10,15}$/.test(phone)) return bad(res, 'Phone must be 10-15 digits');
  if (!(await C('departments').findOne({ _id: deptId }))) return bad(res, 'Choose your department');
  if (await C('users').findOne({ email })) return bad(res, 'An account with this email already exists', 409);

  let refId;
  if (role === 'STUDENT') {
    const prn = String(b.prn || '').trim();
    const year = Number(b.yearOfStudy || 1);
    if (!/^[A-Za-z0-9]{5,20}$/.test(prn)) return bad(res, 'Enter a valid PRN (5-20 letters or digits)');
    if (![1, 2, 3, 4].includes(year)) return bad(res, 'Year of study must be 1 to 4');
    if (await C('students').findOne({ prn })) return bad(res, 'This PRN is already registered', 409);
    refId = await svc.nextId('students');
    await C('students').insertOne({
      _id: refId, prn, name, email, phone, address: b.address ? String(b.address).trim().slice(0, 200) : null,
      yearOfStudy: year, deptId, contactVerifiedAt: null
    });
  } else {
    const code = process.env.FACULTY_CODE;
    if (!code) return bad(res, 'Faculty registration is disabled. Ask an administrator for an account.', 403);
    if (String(b.staffCode || '') !== code) return bad(res, 'Wrong staff registration code', 403);
    refId = await svc.nextId('faculty');
    await C('faculty').insertOne({
      _id: refId, name, email, phone, designation: b.designation ? String(b.designation).trim().slice(0, 60) : null, deptId
    });
  }

  const user = { _id: await svc.nextId('users'), email, passwordHash: await hashPassword(password), role, roleRefId: refId, createdAt: new Date() };
  try {
    await C('users').insertOne(user);
  } catch (e) {                                    // keep the data consistent if the login could not be created
    await C(role === 'STUDENT' ? 'students' : 'faculty').deleteOne({ _id: refId });
    throw e;
  }
  res.json(startSession(user, name));
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!email || !password) return bad(res, 'Email and password are required');

  const f = loginFails.get(email);
  if (f && Date.now() - f.first < 15 * 60 * 1000 && f.count >= 5) return bad(res, 'Too many failed attempts. Try again in 15 minutes.', 429);

  const user = await C('users').findOne({ email });
  if (!user || !(await checkPassword(user, password))) {
    const cur = f && Date.now() - f.first < 15 * 60 * 1000 ? f : { count: 0, first: Date.now() };
    cur.count++; loginFails.set(email, cur);
    console.log(`Login failed for "${email}": ${user ? 'wrong password' : 'no account with this email'}`);
    return bad(res, 'Invalid email or password', 401);
  }
  loginFails.delete(email);
  let name = 'Administrator';
  if (user.role === 'STUDENT') name = (await C('students').findOne({ _id: user.roleRefId })).name;
  if (user.role === 'FACULTY') name = (await C('faculty').findOne({ _id: user.roleRefId })).name;
  res.json(startSession(user, name));
}));

app.post('/api/logout', auth(), (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});

// =====================================================================
//  SHARED: catalog, sections, notifications
// =====================================================================
app.get('/api/courses', auth(), wrap(async (req, res) => {
  const all = await C('courses').find().sort({ courseCode: 1 }).toArray();
  const codes = Object.fromEntries(all.map((c) => [c._id, c.courseCode]));
  res.json(all.map((c) => ({
    id: c._id, code: c.courseCode, title: c.title, description: c.description,
    credits: c.components.reduce((a, x) => a + x.credits, 0),
    prerequisites: c.prerequisites.map((p) => `${codes[p.requiredCourseId]} (min ${p.minGrade}${p.isMandatory ? '' : ', recommended'})`)
  })));
}));

app.get('/api/sections', auth(), wrap(async (req, res) => {
  const sem = await svc.currentSemester();
  const rows = await C('sections').aggregate([
    { $match: { semesterId: sem._id } },
    { $lookup: { from: 'courses', localField: 'courseId', foreignField: '_id', as: 'course' } }, { $unwind: '$course' },
    { $lookup: { from: 'faculty', localField: 'facultyId', foreignField: '_id', as: 'fac' } }, { $unwind: '$fac' },
    { $lookup: { from: 'classrooms', localField: 'roomId', foreignField: '_id', as: 'room' } }, { $unwind: '$room' },
    { $sort: { 'course.courseCode': 1, sectionNumber: 1 } }
  ]).toArray();
  res.json(rows.map((s) => {
    const comp = s.course.components.find((c) => c.componentId === s.componentId);
    return {
      id: s._id, code: s.course.courseCode, title: s.course.title, type: comp.type, credits: comp.credits,
      section: s.sectionNumber, faculty: s.fac.name, room: s.room.roomNumber, slot: s.slot,
      capacity: s.maxCapacity, enrolled: s.enrolledCount, seatsLeft: Math.max(0, s.maxCapacity - s.enrolledCount)
    };
  }));
}));

app.get('/api/notifications', auth(), wrap(async (req, res) => {
  const list = await C('notifications').find({ userId: req.user.userId }).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(list.map((n) => ({ id: n._id, message: n.message, createdAt: n.createdAt, isRead: n.isRead })));
}));
app.post('/api/notifications/read', auth(), wrap(async (req, res) => {
  await C('notifications').updateMany({ userId: req.user.userId, isRead: false }, { $set: { isRead: true } });
  res.json({ ok: true });
}));

// =====================================================================
//  STUDENT
// =====================================================================
const student = auth(['STUDENT']);

app.get('/api/me/summary', student, wrap(async (req, res) => {
  const st = await C('students').findOne({ _id: req.user.refId });
  res.json({ name: st.name, prn: st.prn, verified: !!st.contactVerifiedAt, cgpa: await svc.cgpa(st._id), probation: await svc.isOnProbation(st._id) });
}));

// ---- contact verification (FR: contact details must be verified before enrolling) ----
// No SMS/email provider is connected, so the code is delivered as an in-app notification
// and printed in the server console. Replace sendCode() with a real SMS/email call later.
async function sendCode(st, userId, code) {
  console.log(`[verification] code for ${st.email} / ${st.phone || 'no phone'}: ${code}`);
  await svc.notify(userId, `Your UCMS verification code is ${code}. It expires in 10 minutes.`);
}
app.post('/api/me/verify/request', student, wrap(async (req, res) => {
  const st = await C('students').findOne({ _id: req.user.refId });
  if (st.contactVerifiedAt) return res.json({ ok: true, message: 'Already verified' });
  const code = String(crypto.randomInt(100000, 1000000));
  verifyCodes.set(st._id, { code, expires: Date.now() + 10 * 60 * 1000, tries: 0 });
  await sendCode(st, req.user.userId, code);
  res.json({ ok: true, message: 'Verification code sent. Check your Notifications tab.' });
}));
app.post('/api/me/verify/confirm', student, wrap(async (req, res) => {
  const v = verifyCodes.get(req.user.refId);
  if (!v || Date.now() > v.expires) return bad(res, 'No active code. Request a new one.');
  if (++v.tries > 5) { verifyCodes.delete(req.user.refId); return bad(res, 'Too many wrong attempts. Request a new code.', 429); }
  if (String((req.body || {}).code || '').trim() !== v.code) return bad(res, 'Wrong code');
  verifyCodes.delete(req.user.refId);
  await C('students').updateOne({ _id: req.user.refId }, { $set: { contactVerifiedAt: new Date() } });
  res.json({ ok: true, message: 'Contact details verified. You can enroll now.' });
}));

// ---- enrollments ----
app.get('/api/me/enrollments', student, wrap(async (req, res) => {
  const list = await C('enrollments').find({ studentId: req.user.refId }).toArray();
  const out = [];
  for (const e of list) {
    const sec = await C('sections').findOne({ _id: e.sectionId });
    const { course, comp } = await svc.componentOf(sec);
    out.push({ id: e._id, code: course.courseCode, title: course.title, type: comp.type, section: sec.sectionNumber, slot: sec.slot, status: e.status, grade: e.grade });
  }
  const waits = await C('waitlists').find({ studentId: req.user.refId, waitlistStatus: 'Waiting' }).toArray();
  for (const w of waits) {
    const sec = await C('sections').findOne({ _id: w.sectionId });
    const { course, comp } = await svc.componentOf(sec);
    out.push({ id: null, code: course.courseCode, title: course.title, type: comp.type, section: sec.sectionNumber, slot: sec.slot, status: `Waitlisted (#${w.queuePosition})`, grade: null });
  }
  res.json(out);
}));
app.post('/api/enroll', student, wrap(async (req, res) => {
  const r = await svc.enrollStudent(req.user.refId, Number(req.body.sectionId));
  res.status(r.ok ? 200 : 400).json({ ...r, error: r.ok ? undefined : r.message });
}));
app.post('/api/drop', student, wrap(async (req, res) => {
  const id = Number(req.body.enrollmentId);
  const enr = await C('enrollments').findOne({ _id: id });
  if (!enr || enr.studentId !== req.user.refId) return bad(res, 'Not your enrollment', 403);
  const r = await svc.dropEnrollment(id);
  res.status(r.ok ? 200 : 400).json({ ...r, error: r.ok ? undefined : r.message });
}));

// ---- prerequisite tasks ----
app.get('/api/me/tasks', student, wrap(async (req, res) => {
  const tasks = await C('prerequisiteTasks').find().toArray();
  const courses = Object.fromEntries((await C('courses').find().toArray()).map((c) => [c._id, c]));
  const subs = await C('taskSubmissions').find({ studentId: req.user.refId }).toArray();
  const out = tasks.map((t) => {
    const s = subs.find((x) => x.taskId === t._id);
    return {
      id: t._id, code: courses[t.courseId].courseCode, courseTitle: courses[t.courseId].title, type: t.taskType,
      appliesTo: t.appliesTo, title: t.title, description: t.description, videoUrl: t.videoUrl,
      status: s ? s.status : 'Not started', remarks: s ? s.remarks : null, content: s ? s.content : null,
      done: !!s && (s.status === 'Approved' || (t.taskType === 'Video' && s.status === 'Watched'))
    };
  });
  out.sort((a, b) => a.code.localeCompare(b.code) || a.id - b.id);
  res.json(out);
}));

async function saveSubmission(studentId, taskId, patch) {
  const old = await C('taskSubmissions').findOne({ taskId, studentId });
  if (old) {
    await C('taskSubmissions').updateOne({ _id: old._id }, { $set: { ...patch, submittedAt: new Date(), remarks: null } });
  } else {
    await C('taskSubmissions').insertOne({ _id: await svc.nextId('taskSubmissions'), taskId, studentId, content: null, remarks: null, submittedAt: new Date(), ...patch });
  }
}
app.post('/api/me/tasks/:id/submit', student, wrap(async (req, res) => {
  const task = await C('prerequisiteTasks').findOne({ _id: Number(req.params.id) });
  if (!task || task.taskType !== 'Assignment') return bad(res, 'Assignment not found', 404);
  const content = String((req.body || {}).content || '').trim();
  if (content.length < 10 || content.length > 5000) return bad(res, 'Write your answer (10 to 5000 characters)');
  const old = await C('taskSubmissions').findOne({ taskId: task._id, studentId: req.user.refId });
  if (old && old.status === 'Approved') return bad(res, 'This assignment is already approved');
  await saveSubmission(req.user.refId, task._id, { content, status: 'Submitted' });
  res.json({ ok: true, message: 'Submitted. Your faculty will review it.' });
}));
app.post('/api/me/tasks/:id/watched', student, wrap(async (req, res) => {
  const task = await C('prerequisiteTasks').findOne({ _id: Number(req.params.id) });
  if (!task || task.taskType !== 'Video') return bad(res, 'Video not found', 404);
  await saveSubmission(req.user.refId, task._id, { status: 'Watched' });
  res.json({ ok: true, message: 'Marked as watched.' });
}));

// ---- attendance (student view) ----
app.get('/api/me/attendance', student, wrap(async (req, res) => {
  const sem = await svc.currentSemester();
  const enrs = await C('enrollments').find({ studentId: req.user.refId, status: { $in: ['Enrolled', 'Completed'] } }).toArray();
  const out = [];
  for (const e of enrs) {
    const sec = await C('sections').findOne({ _id: e.sectionId });
    if (sec.semesterId !== sem._id) continue;
    const { course, comp } = await svc.componentOf(sec);
    const rows = await C('attendance').find({ enrollmentId: e._id }).sort({ classDate: -1 }).toArray();
    const count = (s) => rows.filter((r) => r.status === s).length;
    const present = count('Present'), late = count('Late'), absent = count('Absent'), total = rows.length;
    const percent = total ? Math.round(((present + late) / total) * 1000) / 10 : null;
    out.push({
      code: course.courseCode, title: course.title, type: comp.type, section: sec.sectionNumber,
      present, late, absent, total, percent, low: percent !== null && percent < 75,
      recent: rows.slice(0, 10).map((r) => ({ date: r.classDate.toISOString().slice(0, 10), status: r.status }))
    });
  }
  res.json(out);
}));

// =====================================================================
//  FACULTY
// =====================================================================
const faculty = auth(['FACULTY']);
async function ownSection(req, sectionId) {
  const sec = await C('sections').findOne({ _id: Number(sectionId) });
  return sec && sec.facultyId === req.user.refId ? sec : null;
}

app.get('/api/faculty/sections', faculty, wrap(async (req, res) => {
  const sem = await svc.currentSemester();
  const secs = await C('sections').find({ facultyId: req.user.refId, semesterId: sem._id }).toArray();
  const out = [];
  for (const sec of secs) {
    const { course, comp } = await svc.componentOf(sec);
    const enrs = await C('enrollments').find({ sectionId: sec._id, status: { $in: ['Enrolled', 'Completed'] } }).toArray();
    const roster = [];
    for (const e of enrs) {
      const st = await C('students').findOne({ _id: e.studentId });
      roster.push({ enrollmentId: e._id, prn: st.prn, name: st.name, grade: e.grade, status: e.status });
    }
    out.push({ id: sec._id, code: course.courseCode, title: course.title, type: comp.type, section: sec.sectionNumber, slot: sec.slot, roster });
  }
  res.json(out);
}));

app.put('/api/faculty/grade', faculty, wrap(async (req, res) => {
  const { enrollmentId, grade } = req.body || {};
  if (!svc.GRADES.includes(grade)) return bad(res, 'Grade must be one of ' + svc.GRADES.join(', '));
  const enr = await C('enrollments').findOne({ _id: Number(enrollmentId) });
  if (!enr || !(await ownSection(req, enr.sectionId))) return bad(res, 'This is not your section', 403);
  if (enr.status === 'Dropped') return bad(res, 'This student dropped the course');
  res.json(await svc.updateGrade(enr._id, grade, req.user.email));
}));

// ---- attendance (faculty) ----
app.get('/api/faculty/attendance', faculty, wrap(async (req, res) => {
  const sec = await ownSection(req, req.query.sectionId);
  if (!sec) return bad(res, 'This is not your section', 403);
  const day = parseDay(req.query.date);
  if (!day) return bad(res, 'Choose a valid date');
  const enrs = await C('enrollments').find({ sectionId: sec._id, status: 'Enrolled' }).toArray();
  const marks = await C('attendance').find({ enrollmentId: { $in: enrs.map((e) => e._id) }, classDate: day }).toArray();
  const roster = [];
  for (const e of enrs) {
    const st = await C('students').findOne({ _id: e.studentId });
    const m = marks.find((x) => x.enrollmentId === e._id);
    roster.push({ enrollmentId: e._id, prn: st.prn, name: st.name, status: m ? m.status : null });
  }
  res.json(roster);
}));
app.post('/api/faculty/attendance', faculty, wrap(async (req, res) => {
  const { sectionId, date, marks } = req.body || {};
  const sec = await ownSection(req, sectionId);
  if (!sec) return bad(res, 'This is not your section', 403);
  const day = parseDay(date);
  if (!day) return bad(res, 'Choose a valid date');
  if (date > isoDate(Date.now() + 14 * 3600 * 1000)) return bad(res, 'You cannot mark attendance for a future date');
  if (!Array.isArray(marks) || !marks.length) return bad(res, 'No attendance to save');
  const enrs = await C('enrollments').find({ sectionId: sec._id, status: 'Enrolled' }).toArray();
  const valid = new Set(enrs.map((e) => e._id));
  for (const m of marks) {
    if (!valid.has(Number(m.enrollmentId))) return bad(res, 'A student in the list is not enrolled in this section');
    if (!['Present', 'Absent', 'Late'].includes(m.status)) return bad(res, 'Status must be Present, Absent or Late');
  }
  for (const m of marks) {
    const enrollmentId = Number(m.enrollmentId);
    const old = await C('attendance').findOne({ enrollmentId, classDate: day });
    if (old) await C('attendance').updateOne({ _id: old._id }, { $set: { status: m.status } });
    else await C('attendance').insertOne({ _id: await svc.nextId('attendance'), enrollmentId, classDate: day, status: m.status });
  }
  res.json({ ok: true, message: `Attendance saved for ${marks.length} students` });
}));

// ---- review assignment submissions ----
async function myCourseIds(req) {
  const sem = await svc.currentSemester();
  const secs = await C('sections').find({ facultyId: req.user.refId, semesterId: sem._id }).toArray();
  return [...new Set(secs.map((s) => s.courseId))];
}
app.get('/api/faculty/submissions', faculty, wrap(async (req, res) => {
  const ids = await myCourseIds(req);
  const tasks = await C('prerequisiteTasks').find({ courseId: { $in: ids }, taskType: 'Assignment' }).toArray();
  const subs = await C('taskSubmissions').find({ taskId: { $in: tasks.map((t) => t._id) }, status: { $in: ['Submitted', 'Approved', 'Rejected'] } }).toArray();
  const courses = Object.fromEntries((await C('courses').find().toArray()).map((c) => [c._id, c]));
  const out = [];
  for (const s of subs) {
    const t = tasks.find((x) => x._id === s.taskId);
    const st = await C('students').findOne({ _id: s.studentId });
    out.push({ id: s._id, course: courses[t.courseId].courseCode, task: t.title, prn: st.prn, student: st.name,
               content: s.content, status: s.status, remarks: s.remarks, submittedAt: s.submittedAt });
  }
  const rank = { Submitted: 0, Rejected: 1, Approved: 2 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json(out.slice(0, 100));
}));
app.put('/api/faculty/submissions/:id', faculty, wrap(async (req, res) => {
  const { status } = req.body || {};
  const remarks = req.body.remarks ? String(req.body.remarks).trim().slice(0, 500) : null;
  if (!['Approved', 'Rejected'].includes(status)) return bad(res, 'Status must be Approved or Rejected');
  if (status === 'Rejected' && !remarks) return bad(res, 'Please add remarks explaining what to fix');
  const sub = await C('taskSubmissions').findOne({ _id: Number(req.params.id) });
  const task = sub && (await C('prerequisiteTasks').findOne({ _id: sub.taskId }));
  if (!task || task.taskType !== 'Assignment' || !(await myCourseIds(req)).includes(task.courseId)) return bad(res, 'This submission is not for one of your courses', 403);
  await C('taskSubmissions').updateOne({ _id: sub._id }, { $set: { status, remarks } });
  await svc.notifyStudent(sub.studentId, `Your assignment "${task.title}" was ${status.toLowerCase()}${remarks ? ': ' + remarks : ''}`);
  res.json({ ok: true, message: `Submission ${status.toLowerCase()}` });
}));

// =====================================================================
//  ADMIN: courses, sections, prerequisite tasks
// =====================================================================
const admin = auth(['ADMIN']);

app.get('/api/admin/meta', admin, wrap(async (req, res) => {
  res.json({
    departments: (await C('departments').find().toArray()).map((d) => ({ id: d._id, name: d.deptName })),
    faculty: (await C('faculty').find().sort({ name: 1 }).toArray()).map((f) => ({ id: f._id, name: f.name })),
    rooms: (await C('classrooms').find().sort({ roomNumber: 1 }).toArray()).map((r) => ({ id: r._id, number: r.roomNumber, type: r.roomType, capacity: r.roomCapacity })),
    semesters: (await C('semesters').find().sort({ _id: 1 }).toArray()).map((s) => ({ id: s._id, name: s.semesterNumber, current: s.isCurrent })),
    courses: (await C('courses').find().sort({ courseCode: 1 }).toArray()).map((c) => ({ id: c._id, code: c.courseCode, title: c.title, components: c.components }))
  });
}));

// ---- courses ----
app.get('/api/admin/courses', admin, wrap(async (req, res) => {
  const all = await C('courses').find().sort({ courseCode: 1 }).toArray();
  const depts = Object.fromEntries((await C('departments').find().toArray()).map((d) => [d._id, d.deptName]));
  res.json(all.map((c) => ({ ...c, id: c._id, deptName: depts[c.deptId] })));
}));
app.post('/api/admin/courses', admin, wrap(async (req, res) => {
  const v = await svc.validateCourse(req.body || {}, null);
  if (v.error) return bad(res, v.error);
  const id = await svc.nextId('courses');
  await C('courses').insertOne({ _id: id, ...v.doc });
  res.json({ ok: true, message: 'Course created', id });
}));
app.put('/api/admin/courses/:id', admin, wrap(async (req, res) => {
  const existing = await C('courses').findOne({ _id: Number(req.params.id) });
  if (!existing) return bad(res, 'Course not found', 404);
  const v = await svc.validateCourse(req.body || {}, existing);
  if (v.error) return bad(res, v.error);
  await C('courses').updateOne({ _id: existing._id }, { $set: v.doc });
  res.json({ ok: true, message: 'Course updated' });
}));
app.delete('/api/admin/courses/:id', admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await C('courses').findOne({ _id: id }))) return bad(res, 'Course not found', 404);
  if (await C('sections').findOne({ courseId: id })) return bad(res, 'Delete this course\'s sections first');
  const tasks = await C('prerequisiteTasks').find({ courseId: id }).toArray();
  await C('taskSubmissions').deleteMany({ taskId: { $in: tasks.map((t) => t._id) } });
  await C('prerequisiteTasks').deleteMany({ courseId: id });
  await C('courses').updateMany({}, { $pull: { prerequisites: { requiredCourseId: id } } });
  await C('courses').deleteOne({ _id: id });
  res.json({ ok: true, message: 'Course deleted' });
}));

// ---- sections ----
app.get('/api/admin/sections', admin, wrap(async (req, res) => {
  const secs = await C('sections').find().sort({ semesterId: -1, courseId: 1, sectionNumber: 1 }).toArray();
  const fac = Object.fromEntries((await C('faculty').find().toArray()).map((f) => [f._id, f.name]));
  const rooms = Object.fromEntries((await C('classrooms').find().toArray()).map((r) => [r._id, r.roomNumber]));
  const sems = Object.fromEntries((await C('semesters').find().toArray()).map((s) => [s._id, s.semesterNumber]));
  const out = [];
  for (const s of secs) {
    const { course, comp } = await svc.componentOf(s);
    out.push({ id: s._id, courseId: s.courseId, componentId: s.componentId, facultyId: s.facultyId, roomId: s.roomId, semesterId: s.semesterId,
               code: course.courseCode, type: comp.type, section: s.sectionNumber, faculty: fac[s.facultyId], room: rooms[s.roomId],
               semester: sems[s.semesterId], slot: s.slot, capacity: s.maxCapacity, enrolled: s.enrolledCount });
  }
  res.json(out);
}));
app.post('/api/admin/sections', admin, wrap(async (req, res) => {
  const v = await svc.validateSection(req.body || {}, null);
  if (v.error) return bad(res, v.error);
  const id = await svc.nextId('sections');
  await C('sections').insertOne({ _id: id, ...v.doc, enrolledCount: 0 });
  res.json({ ok: true, message: 'Section created', id });
}));
app.put('/api/admin/sections/:id', admin, wrap(async (req, res) => {
  const existing = await C('sections').findOne({ _id: Number(req.params.id) });
  if (!existing) return bad(res, 'Section not found', 404);
  const v = await svc.validateSection(req.body || {}, existing);
  if (v.error) return bad(res, v.error);
  await C('sections').updateOne({ _id: existing._id }, { $set: v.doc });
  res.json({ ok: true, message: 'Section updated' });
}));
app.delete('/api/admin/sections/:id', admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await C('sections').findOne({ _id: id }))) return bad(res, 'Section not found', 404);
  if (await C('enrollments').findOne({ sectionId: id })) return bad(res, 'This section has enrollment records and cannot be deleted');
  if (await C('waitlists').findOne({ sectionId: id })) return bad(res, 'This section has waitlist records and cannot be deleted');
  await C('sections').deleteOne({ _id: id });
  res.json({ ok: true, message: 'Section deleted' });
}));

// ---- prerequisite tasks ----
app.get('/api/admin/tasks', admin, wrap(async (req, res) => {
  const courses = Object.fromEntries((await C('courses').find().toArray()).map((c) => [c._id, c.courseCode]));
  const tasks = await C('prerequisiteTasks').find().sort({ courseId: 1, _id: 1 }).toArray();
  res.json(tasks.map((t) => ({ ...t, id: t._id, code: courses[t.courseId] })));
}));
app.post('/api/admin/tasks', admin, wrap(async (req, res) => {
  const v = await svc.validateTask(req.body || {});
  if (v.error) return bad(res, v.error);
  const id = await svc.nextId('prerequisiteTasks');
  await C('prerequisiteTasks').insertOne({ _id: id, ...v.doc });
  res.json({ ok: true, message: 'Task created', id });
}));
app.put('/api/admin/tasks/:id', admin, wrap(async (req, res) => {
  const existing = await C('prerequisiteTasks').findOne({ _id: Number(req.params.id) });
  if (!existing) return bad(res, 'Task not found', 404);
  const v = await svc.validateTask(req.body || {});
  if (v.error) return bad(res, v.error);
  await C('prerequisiteTasks').updateOne({ _id: existing._id }, { $set: v.doc });
  res.json({ ok: true, message: 'Task updated' });
}));
app.delete('/api/admin/tasks/:id', admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await C('prerequisiteTasks').findOne({ _id: id }))) return bad(res, 'Task not found', 404);
  await C('taskSubmissions').deleteMany({ taskId: id });
  await C('prerequisiteTasks').deleteOne({ _id: id });
  res.json({ ok: true, message: 'Task deleted' });
}));

// =====================================================================
//  START
// =====================================================================
(async () => {
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
  await client.connect();
  db = client.db(process.env.DB_NAME || 'ucms_db');
  svc = makeServices(db);
  if ((await C('users').countDocuments()) === 0) {
    console.warn('WARNING: the users collection is empty. Run ucms_mongo_schema.js first, or nobody can log in.');
  }
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`UCMS running at http://localhost:${port}`));
})().catch((e) => { console.error('Could not start. Is MongoDB running?', e.message); process.exit(1); });
