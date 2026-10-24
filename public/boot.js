// =====================================================================
//  Start-up: decide which dashboard to show
// =====================================================================
function startApp() {
  show('authView', false); show('appView', true);
  $('who').textContent = (sessionStorage.getItem('ucmsName') || '') + ' (' + String(role).toLowerCase() + ')';
  show('studentView', role === 'STUDENT'); show('facultyView', role === 'FACULTY'); show('adminView', role === 'ADMIN');

  if (role === 'STUDENT') {
    wireTabs('student', 'tab-', (t) => { if (t === 'notes') loadNotes('tab-notes', true); });
    refreshStudent(); loadCourses();
  }
  if (role === 'FACULTY') {
    wireTabs('faculty', 'ftab-', (t) => {
      if (t === 'grades') loadFacultyGrades();
      if (t === 'attendance') loadFacultyAttendance();
      if (t === 'reviews') loadReviews();
      if (t === 'notes') loadNotes('ftab-notes', true);
    });
    loadFacultyGrades(); loadReviews(); loadNotes('ftab-notes');
  }
  if (role === 'ADMIN') {
    wireTabs('admin', 'atab-', (t) => {
      if (t === 'overview') loadAdminOverview();
      if (t === 'courses') loadAdminCourses();
      if (t === 'sections') loadAdminSections();
      if (t === 'tasks') loadAdminTasks();
    });
    loadAdminOverview(); loadAdminCourses(); loadAdminSections(); loadAdminTasks();
  }
}
if (token) startApp();
