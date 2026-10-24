// =====================================================================
//  FACULTY dashboard: grades, attendance, assignment reviews
// =====================================================================
let facultySections = [];

async function loadFacultyGrades() {
  const r = await api('/faculty/sections');
  facultySections = r.data || [];
  const box = clear('ftab-grades');
  if (!facultySections.length) box.appendChild(el('div', { class: 'card', text: 'No sections are assigned to you this semester.' }));
  facultySections.forEach((s) => {
    const card = el('div', { class: 'card' }, el('h3', { text: `${s.code} ${s.title} - ${s.type} section ${s.section} (${s.slot})` }));
    card.appendChild(table(['PRN', 'Student', 'Status', 'Grade', 'Set grade'], s.roster.map((st) => {
      const sel = el('select');
      ['', 'A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'F'].forEach((g) => sel.appendChild(el('option', { value: g, text: g || 'Choose' })));
      const save = button('Save', '', async () => {
        if (!sel.value) return;
        const res = await api('/faculty/grade', 'PUT', { enrollmentId: st.enrollmentId, grade: sel.value });
        flash(msgOf(res), !res.ok); loadFacultyGrades();
      });
      return [st.prn, st.name, st.status, st.grade || '-', el('span', {}, sel, ' ', save)];
    }), 'No students enrolled yet.'));
    box.appendChild(card);
  });
}

// ---------- attendance ----------
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadFacultyAttendance() {
  if (!facultySections.length) await loadFacultyGrades();
  const box = clear('ftab-attendance');
  if (!facultySections.length) { box.textContent = 'No sections are assigned to you this semester.'; return; }
  const sel = el('select');
  facultySections.forEach((s) => sel.appendChild(el('option', { value: s.id, text: `${s.code} ${s.type} sec ${s.section} - ${s.slot}` })));
  const date = el('input', { type: 'date', value: todayLocal(), max: todayLocal() });
  const area = el('div');
  const marks = {};

  async function load() {
    area.innerHTML = '';
    if (!date.value) { area.textContent = 'Choose a date.'; return; }
    const r = await api(`/faculty/attendance?sectionId=${sel.value}&date=${date.value}`);
    if (!r.ok) { area.textContent = msgOf(r); return; }
    if (!r.data.length) { area.textContent = 'No students are enrolled in this section.'; return; }
    r.data.forEach((st) => { marks[st.enrollmentId] = st.status || 'Present'; });
    const rows = r.data.map((st) => {
      const seg = el('span', { class: 'seg' });
      ['Present', 'Late', 'Absent'].forEach((v) => {
        const radio = el('input', { type: 'radio', name: 'att-' + st.enrollmentId, value: v, checked: marks[st.enrollmentId] === v });
        radio.onchange = () => { marks[st.enrollmentId] = v; };
        seg.appendChild(el('label', {}, radio, v));
      });
      return [st.prn, st.name, st.status ? tag('Saved: ' + st.status) : tag('Not marked yet'), seg];
    });
    area.appendChild(table(['PRN', 'Student', 'Current', 'Mark'], rows));
    area.appendChild(el('div', { class: 'row' },
      button('Mark everyone present', 'ghost-dark', () => {
        r.data.forEach((st) => { marks[st.enrollmentId] = 'Present'; });
        area.querySelectorAll('input[type=radio][value=Present]').forEach((x) => { x.checked = true; });
      }),
      button('Save attendance', '', async () => {
        const res = await api('/faculty/attendance', 'POST', {
          sectionId: Number(sel.value), date: date.value,
          marks: r.data.map((st) => ({ enrollmentId: st.enrollmentId, status: marks[st.enrollmentId] }))
        });
        flash(msgOf(res), !res.ok); if (res.ok) load();
      })));
  }
  sel.onchange = load; date.onchange = load;
  box.append(el('h3', { text: 'Mark attendance' }), el('div', { class: 'row' }, el('label', {}, 'Section', sel), el('label', {}, 'Date', date)), area);
  load();
}

// ---------- assignment reviews ----------
async function loadReviews() {
  const r = await api('/faculty/submissions');
  const box = clear('ftab-reviews');
  box.appendChild(el('p', { class: 'muted', text: 'Assignments submitted by students for the courses you teach. Approved assignments unlock enrollment.' }));
  if (!r.data.length) box.appendChild(el('div', { class: 'card', text: 'No submissions yet.' }));
  r.data.forEach((s) => {
    const cls = s.status === 'Approved' ? 'ok' : s.status === 'Rejected' ? 'bad' : '';
    const card = el('div', { class: 'task' },
      el('h3', { text: `${s.course} - ${s.task}` }),
      el('div', { class: 'meta', text: `${s.student} (${s.prn}) | ${fmtDate(s.submittedAt)}` }),
      el('div', { class: 'answer', text: s.content || '' }),
      el('div', {}, tag(s.status, cls)));
    if (s.remarks) card.appendChild(el('div', { class: 'remarks', text: 'Remarks: ' + s.remarks }));
    if (s.status === 'Submitted') {
      card.appendChild(el('div', { class: 'row' },
        button('Approve', '', async () => {
          const res = await api('/faculty/submissions/' + s.id, 'PUT', { status: 'Approved' }); flash(msgOf(res), !res.ok); loadReviews();
        }),
        button('Reject...', 'warn', () => formDialog({
          title: `Reject ${s.student}'s submission`, submitLabel: 'Reject',
          fields: [{ name: 'remarks', label: 'What should the student fix?', type: 'textarea' }],
          onSubmit: async (d) => {
            const res = await api('/faculty/submissions/' + s.id, 'PUT', { status: 'Rejected', remarks: d.remarks });
            if (!res.ok) return msgOf(res);
            flash(msgOf(res)); loadReviews();
          }
        }))));
    }
    box.appendChild(card);
  });
}
