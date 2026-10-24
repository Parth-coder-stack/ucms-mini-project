// Business logic. MongoDB has no triggers or stored functions, so every write
// goes through these functions (this replaces the MySQL triggers/functions).
const { parseSlot, slotsOverlap } = require('./slots');

const GRADES = ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'F'];
const POINTS = { 'A+': 10, A: 9, 'B+': 8, B: 7, 'C+': 6, C: 5, D: 4 };
const gradePoints = (g) => POINTS[g] || 0;

module.exports = function makeServices(db) {
  const C = (n) => db.collection(n);

  async function nextId(name) {
    const doc = await C('counters').findOneAndUpdate(
      { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    return doc.seq;
  }

  // component ids live inside courses, so take max + 1
  async function maxComponentId() {
    const r = await C('courses').aggregate([
      { $unwind: '$components' }, { $group: { _id: null, m: { $max: '$components.componentId' } } }]).toArray();
    return r.length ? r[0].m : 0;
  }

  const currentSemester = () => C('semesters').findOne({ isCurrent: true });

  async function componentOf(sec) {
    const course = await C('courses').findOne({ _id: sec.courseId });
    const comp = course.components.find((c) => c.componentId === sec.componentId);
    return { course, comp };
  }
  async function sectionKey(sec) {
    const { course, comp } = await componentOf(sec);
    return `${course.courseCode}-${comp.type}-${sec.sectionNumber}`;
  }

  // ---------------- GPA ----------------
  async function gpa(studentId, semesterId) {
    const done = await C('enrollments').find({ studentId, status: 'Completed', grade: { $ne: null } }).toArray();
    let points = 0, credits = 0;
    for (const e of done) {
      const sec = await C('sections').findOne({ _id: e.sectionId });
      if (semesterId != null && sec.semesterId !== semesterId) continue;
      const { comp } = await componentOf(sec);
      points += gradePoints(e.grade) * comp.credits;
      credits += comp.credits;
    }
    return credits === 0 ? 0 : Math.round((points / credits) * 100) / 100;
  }
  const cgpa = (studentId) => gpa(studentId, null);
  async function isOnProbation(studentId) {
    const s = await C('systemSettings').findOne({ _id: 'probation_cgpa' });
    return (await cgpa(studentId)) < parseFloat(s.value);
  }

  // ---------------- notifications ----------------
  async function notify(userId, message) {
    await C('notifications').insertOne({ _id: await nextId('notifications'), userId, message, createdAt: new Date(), isRead: false });
  }
  async function notifyStudent(studentId, message) {
    const u = await C('users').findOne({ role: 'STUDENT', roleRefId: studentId });
    if (u) await notify(u._id, message);
  }

  // ---------------- grades (audit trail + notification) ----------------
  async function updateGrade(enrollmentId, newGrade, changedBy) {
    const enr = await C('enrollments').findOne({ _id: enrollmentId });
    if (!enr) return { ok: false, message: 'Enrollment not found' };
    if (enr.grade === newGrade) return { ok: true, message: 'No change' };
    const wasEnrolled = enr.status === 'Enrolled';
    await C('enrollments').updateOne({ _id: enrollmentId }, { $set: { grade: newGrade, status: 'Completed' } });
    // a graded (Completed) student no longer holds a seat: enrolledCount counts status 'Enrolled' only, as in schema.sql
    if (wasEnrolled) await releaseSeat(enr.sectionId);
    const sec = await C('sections').findOne({ _id: enr.sectionId });
    const student = await C('students').findOne({ _id: enr.studentId });
    const key = await sectionKey(sec);
    await C('auditLogs').insertOne({
      _id: await nextId('auditLogs'), changedBy, studentPrn: student.prn, sectionKey: key,
      oldGrade: enr.grade, newGrade, changedAt: new Date()
    });
    await notifyStudent(enr.studentId, `Grade posted: ${newGrade} in ${key}`);
    return { ok: true, message: 'Grade updated' };
  }

  // ---------------- enrollment rules ----------------
  // FR-07: required courses passed with the minimum grade
  async function prerequisitesMet(studentId, courseId) {
    const course = await C('courses').findOne({ _id: courseId });
    const needed = course.prerequisites.filter((p) => p.isMandatory);
    if (!needed.length) return { ok: true };
    const done = await C('enrollments').find({ studentId, status: 'Completed', grade: { $ne: null } }).toArray();
    const best = {};
    for (const e of done) {
      const sec = await C('sections').findOne({ _id: e.sectionId });
      const pts = gradePoints(e.grade);
      if (best[sec.courseId] === undefined || pts > best[sec.courseId]) best[sec.courseId] = pts;
    }
    const missing = [];
    for (const p of needed) {
      const have = best[p.requiredCourseId];
      if (have === undefined || have < gradePoints(p.minGrade)) {
        const rc = await C('courses').findOne({ _id: p.requiredCourseId });
        missing.push(`${rc.courseCode} (min grade ${p.minGrade})`);
      }
    }
    return missing.length ? { ok: false, message: 'Prerequisite course not met: ' + missing.join(', ') } : { ok: true };
  }

  // prerequisite tasks: an Assignment must be Approved, a Video must be Watched
  async function tasksComplete(studentId, courseId, componentType) {
    const tasks = await C('prerequisiteTasks').find({ courseId, appliesTo: { $in: ['Both', componentType] } }).toArray();
    if (!tasks.length) return { ok: true };
    const subs = await C('taskSubmissions').find({ studentId, taskId: { $in: tasks.map((t) => t._id) } }).toArray();
    const open = tasks.filter((t) => {
      const s = subs.find((x) => x.taskId === t._id);
      return !(s && (s.status === 'Approved' || (t.taskType === 'Video' && s.status === 'Watched')));
    });
    return open.length
      ? { ok: false, message: 'Complete these prerequisite tasks first: ' + open.map((t) => t.title).join('; ') }
      : { ok: true };
  }

  // student timetable overlap (only against sections they are enrolled in, same semester)
  async function studentClash(studentId, sec) {
    const active = await C('enrollments').find({ studentId, status: 'Enrolled' }).toArray();
    for (const e of active) {
      const other = await C('sections').findOne({ _id: e.sectionId });
      if (other._id !== sec._id && other.semesterId === sec.semesterId && slotsOverlap(other.slot, sec.slot)) {
        return `Timetable clash with ${await sectionKey(other)} (${other.slot})`;
      }
    }
    return null;
  }

  async function takeSeat(sec, overridden) {
    const filter = overridden ? { _id: sec._id } : { _id: sec._id, enrolledCount: { $lt: sec.maxCapacity } };
    const r = await C('sections').updateOne(filter, { $inc: { enrolledCount: 1 } });
    return r.modifiedCount === 1;
  }
  const releaseSeat = (sectionId) => C('sections').updateOne({ _id: sectionId }, { $inc: { enrolledCount: -1 } });

  async function writeEnrollment(studentId, sectionId, overridden) {
    const old = await C('enrollments').findOne({ studentId, sectionId });
    if (old) {
      await C('enrollments').updateOne({ _id: old._id },
        { $set: { status: 'Enrolled', grade: null, enrollmentDate: new Date(), isOverridden: overridden } });
    } else {
      await C('enrollments').insertOne({
        _id: await nextId('enrollments'), studentId, sectionId, status: 'Enrolled',
        grade: null, enrollmentDate: new Date(), isOverridden: overridden
      });
    }
  }

  async function enrollStudent(studentId, sectionId, overridden = false) {
    const student = await C('students').findOne({ _id: studentId });
    if (!student) return { ok: false, message: 'Student not found' };
    if (!student.contactVerifiedAt) return { ok: false, message: 'Verify your contact details before enrolling (use the banner at the top).' };

    const sec = await C('sections').findOne({ _id: sectionId });
    if (!sec) return { ok: false, message: 'Section not found' };
    const sem = await C('semesters').findOne({ _id: sec.semesterId });
    if (!sem.isCurrent) return { ok: false, message: 'Registration is only open for the current semester' };

    const existing = await C('enrollments').findOne({ studentId, sectionId });
    if (existing && existing.status !== 'Dropped') return { ok: false, message: 'Already enrolled in this section' };

    const { comp } = await componentOf(sec);
    const pre = await prerequisitesMet(studentId, sec.courseId);
    if (!pre.ok) return pre;
    const tasks = await tasksComplete(studentId, sec.courseId, comp.type);
    if (!tasks.ok) return tasks;

    const active = await C('enrollments').find({ studentId, status: 'Enrolled' }).toArray();
    for (const e of active) {
      const other = await C('sections').findOne({ _id: e.sectionId });
      if (other._id !== sec._id && other.courseId === sec.courseId &&
          other.componentId === sec.componentId && other.semesterId === sec.semesterId) {
        return { ok: false, message: 'FR-09: already enrolled in another section of this course' };
      }
    }
    const clash = await studentClash(studentId, sec);
    if (clash) return { ok: false, message: clash };

    if (await takeSeat(sec, overridden)) {
      try {
        await writeEnrollment(studentId, sectionId, overridden);
      } catch (err) {
        await releaseSeat(sectionId);
        return { ok: false, message: 'Enrollment failed: ' + err.message };
      }
      return { ok: true, waitlisted: false, message: 'Enrolled successfully' };
    }

    const already = await C('waitlists').findOne({ studentId, sectionId });
    if (already && already.waitlistStatus === 'Waiting') {
      return { ok: false, message: `Already on the waitlist (position ${already.queuePosition})` };
    }
    const last = await C('waitlists').find({ sectionId }).sort({ queuePosition: -1 }).limit(1).toArray();
    const position = last.length ? last[0].queuePosition + 1 : 1;
    if (already) {
      await C('waitlists').updateOne({ _id: already._id },
        { $set: { waitlistStatus: 'Waiting', queuePosition: position, waitlistDate: new Date() } });
    } else {
      await C('waitlists').insertOne({
        _id: await nextId('waitlists'), studentId, sectionId, queuePosition: position,
        waitlistStatus: 'Waiting', waitlistDate: new Date()
      });
    }
    return { ok: true, waitlisted: true, position, message: `Section full - added to waitlist at position ${position}` };
  }

  async function promoteNext(sectionId) {
    const sec = await C('sections').findOne({ _id: sectionId });
    const next = await C('waitlists').find({ sectionId, waitlistStatus: 'Waiting' }).sort({ queuePosition: 1 }).limit(1).toArray();
    if (!next.length) return null;
    const w = next[0];
    if (!(await takeSeat(sec, false))) return null;
    await writeEnrollment(w.studentId, sectionId, false);
    await C('waitlists').updateOne({ _id: w._id }, { $set: { waitlistStatus: 'Promoted' } });
    const key = (await sectionKey(sec)).replace(/-/g, ' ');
    await notifyStudent(w.studentId, `A seat opened! You were moved from the waitlist into ${key}`);
    return w.studentId;
  }

  async function dropEnrollment(enrollmentId) {
    const enr = await C('enrollments').findOne({ _id: enrollmentId });
    if (!enr || enr.status !== 'Enrolled') return { ok: false, message: 'No active enrollment to drop' };
    const sec = await C('sections').findOne({ _id: enr.sectionId });
    const sem = await C('semesters').findOne({ _id: sec.semesterId });
    if (Date.now() > sem.dropDeadline.getTime() + 86400000) return { ok: false, message: 'The drop deadline for this semester has passed' };
    await C('enrollments').updateOne({ _id: enrollmentId }, { $set: { status: 'Dropped' } });
    await releaseSeat(enr.sectionId);
    const promoted = await promoteNext(enr.sectionId);
    return { ok: true, message: promoted ? 'Dropped. The next student on the waitlist was promoted.' : 'Dropped' };
  }

  // ---------------- admin validation ----------------
  async function sectionClash(cand, excludeId) {
    const same = await C('sections').find({ semesterId: cand.semesterId }).toArray();
    for (const o of same) {
      if (o._id === excludeId || !slotsOverlap(o.slot, cand.slot)) continue;
      if (o.facultyId === cand.facultyId) return `Faculty is already teaching ${await sectionKey(o)} at ${o.slot}`;
      if (o.roomId === cand.roomId) return `Room is already used by ${await sectionKey(o)} at ${o.slot}`;
    }
    return null;
  }

  async function validateSection(input, existing) {
    const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
    const courseId = existing ? existing.courseId : num(input.courseId);
    const componentId = existing ? existing.componentId : num(input.componentId);
    const semesterId = existing ? existing.semesterId : num(input.semesterId);
    const facultyId = num(input.facultyId), roomId = num(input.roomId), maxCapacity = num(input.maxCapacity);
    const sectionNumber = String(input.sectionNumber || '').trim().toUpperCase();
    const slot = String(input.slot || '').trim();

    const course = await C('courses').findOne({ _id: courseId });
    if (!course) return { error: 'Choose a course' };
    const comp = course.components.find((c) => c.componentId === componentId);
    if (!comp) return { error: 'Choose a component (Theory/Lab) of that course' };
    if (!(await C('semesters').findOne({ _id: semesterId }))) return { error: 'Choose a semester' };
    if (!(await C('faculty').findOne({ _id: facultyId }))) return { error: 'Choose a faculty member' };
    const room = await C('classrooms').findOne({ _id: roomId });
    if (!room) return { error: 'Choose a classroom' };
    if (room.roomType !== comp.type) return { error: `A ${comp.type} section needs a ${comp.type} room` };
    if (!/^[A-Z0-9]{1,5}$/.test(sectionNumber)) return { error: 'Section number must be 1-5 letters or digits' };
    if (!Number.isInteger(maxCapacity) || maxCapacity < 1) return { error: 'Capacity must be a whole number of at least 1' };
    if (maxCapacity > room.roomCapacity) return { error: `Capacity cannot exceed the room capacity (${room.roomCapacity})` };
    if (existing && maxCapacity < existing.enrolledCount) return { error: `Capacity cannot be below the ${existing.enrolledCount} students already enrolled` };
    if (!parseSlot(slot)) return { error: 'Time slot must look like "Mon/Wed 09:00-10:30" (24-hour, end after start)' };

    const dupe = await C('sections').findOne({ courseId, componentId, semesterId, sectionNumber });
    if (dupe && (!existing || dupe._id !== existing._id)) return { error: 'That section number already exists for this course and semester' };
    const clash = await sectionClash({ semesterId, facultyId, roomId, slot }, existing && existing._id);
    if (clash) return { error: 'Timetable clash: ' + clash };

    return { doc: { courseId, componentId, facultyId, roomId, semesterId, sectionNumber, maxCapacity, slot } };
  }

  async function createsCycle(courseId, newPrereqIds) {
    const all = await C('courses').find().toArray();
    const graph = {};
    all.forEach((c) => { graph[c._id] = c.prerequisites.map((p) => p.requiredCourseId); });
    graph[courseId] = newPrereqIds;
    const seen = new Set();
    const stack = [...newPrereqIds];
    while (stack.length) {
      const n = stack.pop();
      if (n === courseId) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      (graph[n] || []).forEach((x) => stack.push(x));
    }
    return false;
  }

  async function validateCourse(input, existing) {
    const courseCode = String(input.courseCode || '').trim().toUpperCase();
    const title = String(input.title || '').trim();
    const description = input.description ? String(input.description).trim().slice(0, 1000) : null;
    const deptId = Number(input.deptId);
    if (!/^[A-Z0-9]{2,15}$/.test(courseCode)) return { error: 'Course code must be 2-15 letters or digits (e.g. CS601)' };
    if (title.length < 2 || title.length > 150) return { error: 'Title must be 2-150 characters' };
    if (!(await C('departments').findOne({ _id: deptId }))) return { error: 'Choose a department' };
    const dupe = await C('courses').findOne({ courseCode });
    if (dupe && (!existing || dupe._id !== existing._id)) return { error: 'That course code already exists' };

    const inComps = Array.isArray(input.components) ? input.components : [];
    if (!inComps.length) return { error: 'Add at least one component (Theory or Lab)' };
    const types = new Set();
    let nextComp = await maxComponentId();
    const components = [];
    for (const c of inComps) {
      const credits = Number(c.credits);
      if (!['Theory', 'Lab'].includes(c.type)) return { error: 'Component type must be Theory or Lab' };
      if (types.has(c.type)) return { error: `Only one ${c.type} component is allowed` };
      types.add(c.type);
      if (!(credits >= 0.5 && credits <= 10)) return { error: `${c.type} credits must be between 0.5 and 10` };
      const old = existing && existing.components.find((x) => x.type === c.type);
      components.push({
        componentId: old ? old.componentId : ++nextComp, type: c.type,
        credits: Math.round(credits * 10) / 10, evaluationType: c.evaluationType ? String(c.evaluationType).trim().slice(0, 60) : null
      });
    }
    if (existing) {
      for (const old of existing.components) {
        if (!components.some((c) => c.componentId === old.componentId) &&
            await C('sections').findOne({ componentId: old.componentId })) {
          return { error: `Cannot remove the ${old.type} component because sections already use it` };
        }
      }
    }

    const inPre = Array.isArray(input.prerequisites) ? input.prerequisites : [];
    const prerequisites = [];
    const seen = new Set();
    for (const p of inPre) {
      const rid = Number(p.requiredCourseId);
      if (existing && rid === existing._id) return { error: 'A course cannot be its own prerequisite' };
      if (seen.has(rid)) return { error: 'The same prerequisite is listed twice' };
      seen.add(rid);
      if (!(await C('courses').findOne({ _id: rid }))) return { error: 'A prerequisite course does not exist' };
      if (!GRADES.includes(p.minGrade) || p.minGrade === 'F') return { error: 'Choose a valid minimum grade' };
      prerequisites.push({ requiredCourseId: rid, minGrade: p.minGrade, isMandatory: p.isMandatory !== false });
    }
    if (existing && (await createsCycle(existing._id, prerequisites.map((p) => p.requiredCourseId)))) {
      return { error: 'These prerequisites would create a circular chain' };
    }
    return { doc: { courseCode, title, description, deptId, components, prerequisites } };
  }

  async function validateTask(input) {
    const courseId = Number(input.courseId);
    const course = await C('courses').findOne({ _id: courseId });
    const title = String(input.title || '').trim();
    if (!course) return { error: 'Choose a course' };
    if (!['Assignment', 'Video'].includes(input.taskType)) return { error: 'Task type must be Assignment or Video' };
    if (!['Both', 'Theory', 'Lab'].includes(input.appliesTo)) return { error: 'Choose where the task applies' };
    if (input.appliesTo !== 'Both' && !course.components.some((c) => c.type === input.appliesTo)) {
      return { error: `That course has no ${input.appliesTo} component` };
    }
    if (title.length < 2 || title.length > 150) return { error: 'Title must be 2-150 characters' };
    let videoUrl = null;
    if (input.taskType === 'Video') {
      videoUrl = String(input.videoUrl || '').trim();
      if (!/^https?:\/\/\S+$/i.test(videoUrl) || videoUrl.length > 300) return { error: 'Videos need a valid http(s) link' };
    }
    const description = input.description ? String(input.description).trim().slice(0, 1000) : null;
    return { doc: { courseId, taskType: input.taskType, appliesTo: input.appliesTo, title, description, videoUrl } };
  }

  return {
    GRADES, nextId, currentSemester, componentOf, sectionKey, gpa, cgpa, isOnProbation, notify, notifyStudent,
    updateGrade, enrollStudent, dropEnrollment, validateSection, validateCourse, validateTask
  };
};
