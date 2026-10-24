// =====================================================================
//  ADMIN dashboard: overview, courses, sections, prerequisite tasks
// =====================================================================
let adminMeta = null;
async function meta(force) {
  if (!adminMeta || force) adminMeta = (await api('/admin/meta')).data;
  return adminMeta;
}
const opts = (list, label, blank) => [...(blank ? [{ value: '', label: blank }] : []), ...list.map((x) => ({ value: x.id, label: label(x) }))];
const GRADES_MIN = ['D', 'C', 'C+', 'B', 'B+', 'A', 'A+'];

async function loadAdminOverview() {
  const r = await api('/sections');
  const box = clear('atab-overview');
  box.append(el('h2', { text: 'Current semester - seat usage' }),
    table(['Course', 'Type', 'Sec', 'Faculty', 'Room', 'Time', 'Filled'],
      r.data.map((s) => [s.code, s.type, s.section, s.faculty, s.room, s.slot,
        el('span', {}, el('progress', { max: s.capacity, value: s.enrolled }), ` ${s.enrolled} / ${s.capacity}`)])));
}

// ---------------- courses ----------------
async function loadAdminCourses() {
  const r = await api('/admin/courses');
  const box = clear('atab-courses');
  box.append(el('div', { class: 'toolbar' }, el('h2', { text: 'Courses' }), button('+ Add course', '', () => courseDialog(null))));
  box.appendChild(table(['Code', 'Title', 'Dept', 'Components', 'Prerequisites', ''], r.data.map((c) => {
    const codes = Object.fromEntries(r.data.map((x) => [x._id, x.courseCode]));
    return [c.courseCode, c.title, c.deptName,
      c.components.map((x) => `${x.type} ${x.credits}cr`).join(', '),
      c.prerequisites.map((p) => `${codes[p.requiredCourseId]} (${p.minGrade}${p.isMandatory ? '' : ', optional'})`).join(', ') || 'None',
      el('span', { class: 'row' }, button('Edit', 'alt', () => courseDialog(c)),
        button('Delete', 'warn', async () => {
          if (!confirm(`Delete ${c.courseCode}? Its prerequisite tasks and submissions are deleted too.`)) return;
          const res = await api('/admin/courses/' + c._id, 'DELETE'); flash(msgOf(res), !res.ok);
          await meta(true); loadAdminCourses();
        }))];
  })));
}

async function courseDialog(course) {
  const m = await meta(true);
  const comp = (type) => (course ? course.components.find((c) => c.type === type) : null) || {};
  const others = m.courses.filter((c) => !course || c.id !== course._id);
  formDialog({
    title: course ? `Edit ${course.courseCode}` : 'Add course',
    values: {
      courseCode: course && course.courseCode, title: course && course.title, description: course && course.description,
      deptId: course && course.deptId, theoryCredits: comp('Theory').credits, theoryEval: comp('Theory').evaluationType,
      labCredits: comp('Lab').credits, labEval: comp('Lab').evaluationType
    },
    fields: [
      { name: 'courseCode', label: 'Course code', placeholder: 'e.g. CS601', maxLength: 15 },
      { name: 'title', label: 'Title', maxLength: 150 },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'deptId', label: 'Department', type: 'select', options: opts(m.departments, (d) => d.name, 'Choose department') },
      { name: 'theoryCredits', label: 'Theory credits', type: 'number', min: 0.5, max: 10, step: 0.5, hint: 'Leave empty if the course has no theory part' },
      { name: 'theoryEval', label: 'Theory evaluation', placeholder: 'e.g. Internal+External' },
      { name: 'labCredits', label: 'Lab credits', type: 'number', min: 0.5, max: 10, step: 0.5, hint: 'Leave empty if the course has no lab' },
      { name: 'labEval', label: 'Lab evaluation', placeholder: 'e.g. Practical' }
    ],
    build: (form) => {
      const rows = others.map((o) => {
        const cur = course && course.prerequisites.find((p) => p.requiredCourseId === o.id);
        const use = el('input', { type: 'checkbox', checked: !!cur });
        const grade = el('select');
        GRADES_MIN.forEach((g) => grade.appendChild(el('option', { value: g, text: g, selected: cur ? cur.minGrade === g : g === 'D' })));
        const must = el('input', { type: 'checkbox', checked: cur ? cur.isMandatory : true });
        return { o, use, grade, must, cells: [use, `${o.code} ${o.title}`, grade, must] };
      });
      form.appendChild(el('strong', { text: 'Prerequisite courses' }));
      const t = table(['Use', 'Course', 'Min grade', 'Required'], rows.map((r) => r.cells), 'No other courses yet.');
      t.className = 'prereq-table';
      form.appendChild(t);
      return () => ({ prerequisites: rows.filter((r) => r.use.checked).map((r) => ({ requiredCourseId: r.o.id, minGrade: r.grade.value, isMandatory: r.must.checked })) });
    },
    onSubmit: async (d) => {
      const components = [];
      if (d.theoryCredits !== '') components.push({ type: 'Theory', credits: d.theoryCredits, evaluationType: d.theoryEval });
      if (d.labCredits !== '') components.push({ type: 'Lab', credits: d.labCredits, evaluationType: d.labEval });
      const body = { courseCode: d.courseCode, title: d.title, description: d.description, deptId: d.deptId, components, prerequisites: d.prerequisites };
      const res = course ? await api('/admin/courses/' + course._id, 'PUT', body) : await api('/admin/courses', 'POST', body);
      if (!res.ok) return msgOf(res);
      flash(msgOf(res)); await meta(true); loadAdminCourses();
    }
  });
}

// ---------------- sections ----------------
async function loadAdminSections() {
  const r = await api('/admin/sections');
  const box = clear('atab-sections');
  box.append(el('div', { class: 'toolbar' }, el('h2', { text: 'Sections' }), button('+ Add section', '', () => sectionDialog(null))));
  box.appendChild(table(['Semester', 'Course', 'Type', 'Sec', 'Faculty', 'Room', 'Time', 'Enrolled / Cap', ''], r.data.map((s) => [
    s.semester, s.code, s.type, s.section, s.faculty, s.room, s.slot, `${s.enrolled} / ${s.capacity}`,
    el('span', { class: 'row' }, button('Edit', 'alt', () => sectionDialog(s)),
      button('Delete', 'warn', async () => {
        if (!confirm(`Delete section ${s.code} ${s.type} ${s.section}?`)) return;
        const res = await api('/admin/sections/' + s.id, 'DELETE'); flash(msgOf(res), !res.ok); loadAdminSections();
      }))])));
}

async function sectionDialog(sec) {
  const m = await meta(true);
  const cur = m.semesters.find((s) => s.current);
  const dlg = formDialog({
    title: sec ? `Edit ${sec.code} ${sec.type} section ${sec.section}` : 'Add section',
    values: sec ? { courseId: sec.courseId, semesterId: sec.semesterId, facultyId: sec.facultyId, roomId: sec.roomId,
                    sectionNumber: sec.section, maxCapacity: sec.capacity, slot: sec.slot }
                : { semesterId: cur && cur.id },
    fields: [
      { name: 'courseId', label: 'Course', type: 'select', disabled: !!sec, options: opts(m.courses, (c) => `${c.code} ${c.title}`, 'Choose course') },
      { name: 'componentId', label: 'Component', type: 'select', disabled: !!sec, options: [{ value: '', label: 'Choose a course first' }] },
      { name: 'semesterId', label: 'Semester', type: 'select', disabled: !!sec, options: opts(m.semesters, (s) => s.name + (s.current ? ' (current)' : '')) },
      { name: 'facultyId', label: 'Faculty', type: 'select', options: opts(m.faculty, (f) => f.name, 'Choose faculty') },
      { name: 'roomId', label: 'Classroom', type: 'select', options: opts(m.rooms, (r) => `${r.number} - ${r.type}, seats ${r.capacity}`, 'Choose classroom') },
      { name: 'sectionNumber', label: 'Section', placeholder: 'A', maxLength: 5 },
      { name: 'maxCapacity', label: 'Capacity', type: 'number', min: 1 },
      { name: 'slot', label: 'Time slot', placeholder: 'Mon/Wed 09:00-10:30', hint: 'Days separated by /, 24-hour times. Faculty and room clashes are blocked.' }
    ],
    onSubmit: async (d) => {
      const body = { courseId: d.courseId, componentId: d.componentId, semesterId: d.semesterId, facultyId: d.facultyId,
                     roomId: d.roomId, sectionNumber: d.sectionNumber, maxCapacity: d.maxCapacity, slot: d.slot };
      const res = sec ? await api('/admin/sections/' + sec.id, 'PUT', body) : await api('/admin/sections', 'POST', body);
      if (!res.ok) return msgOf(res);
      flash(msgOf(res)); loadAdminSections();
    }
  });
  const fill = () => {
    const c = m.courses.find((x) => String(x.id) === dlg.inputs.courseId.value);
    const box = dlg.inputs.componentId; box.innerHTML = '';
    if (!c) { box.appendChild(el('option', { value: '', text: 'Choose a course first' })); return; }
    c.components.forEach((x) => box.appendChild(el('option', { value: x.componentId, text: `${x.type} (${x.credits} credits)` })));
    if (sec) box.value = sec.componentId;
  };
  dlg.inputs.courseId.onchange = fill; fill();
}

// ---------------- prerequisite tasks ----------------
async function loadAdminTasks() {
  const r = await api('/admin/tasks');
  const box = clear('atab-tasks');
  box.append(el('div', { class: 'toolbar' }, el('h2', { text: 'Prerequisite tasks' }), button('+ Add task', '', () => taskDialog(null))));
  box.appendChild(table(['Course', 'Type', 'Applies to', 'Title', 'Video link', ''], r.data.map((t) => [
    t.code, t.taskType, t.appliesTo, t.title, t.videoUrl || '-',
    el('span', { class: 'row' }, button('Edit', 'alt', () => taskDialog(t)),
      button('Delete', 'warn', async () => {
        if (!confirm('Delete this task and all student submissions for it?')) return;
        const res = await api('/admin/tasks/' + t.id, 'DELETE'); flash(msgOf(res), !res.ok); loadAdminTasks();
      }))])));
}

async function taskDialog(task) {
  const m = await meta(true);
  formDialog({
    title: task ? 'Edit task' : 'Add prerequisite task',
    values: task || {},
    fields: [
      { name: 'courseId', label: 'Course', type: 'select', options: opts(m.courses, (c) => `${c.code} ${c.title}`, 'Choose course') },
      { name: 'taskType', label: 'Type', type: 'select', options: [{ value: 'Assignment', label: 'Assignment (student writes an answer)' }, { value: 'Video', label: 'Video (student watches)' }] },
      { name: 'appliesTo', label: 'Required for', type: 'select', options: [{ value: 'Both', label: 'Theory and Lab' }, { value: 'Theory', label: 'Theory only' }, { value: 'Lab', label: 'Lab only' }] },
      { name: 'title', label: 'Title', maxLength: 150 },
      { name: 'description', label: 'Instructions', type: 'textarea' },
      { name: 'videoUrl', label: 'Video link', placeholder: 'https://...', hint: 'Required for videos, ignored for assignments' }
    ],
    onSubmit: async (d) => {
      const res = task ? await api('/admin/tasks/' + task.id, 'PUT', d) : await api('/admin/tasks', 'POST', d);
      if (!res.ok) return msgOf(res);
      flash(msgOf(res)); loadAdminTasks();
    }
  });
}
