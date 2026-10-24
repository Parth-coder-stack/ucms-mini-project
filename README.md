# UCMS - University Course Management System (Node.js + Express + MongoDB)

## Run it
1. Install Node.js (LTS) and MongoDB Community Server, and make sure MongoDB is running.
2. Load the database once:  mongosh "mongodb://localhost:27017" --file ucms_mongo_schema.js
3. In this folder:
       npm install
       npm start
4. Open http://localhost:3000

## Demo logins
| Role    | Email                          | Password |
|---------|--------------------------------|----------|
| Student | parth.vohra@student.edu        | stud123  |
| Student | meera.iyer@student.edu         | stud123  |
| Faculty | rahul.mehta@university.edu     | fac123   |
| Admin   | admin@ucms.edu                 | admin123 |

Or click Register to create a new student account. Faculty registration needs the staff code
from the FACULTY_CODE line in .env (default UCMS-STAFF-2026). Change it, or leave it empty to disable.

## Settings (.env)
MONGO_URI, DB_NAME, PORT, FACULTY_CODE

## Notes
- Passwords are stored with bcrypt. The old SHA-256 demo hashes are upgraded to bcrypt the first time each account logs in.
- Contact verification: no SMS/email service is connected, so the 6-digit code is shown in the student's
  Notifications tab and printed in the server console. Replace sendCode() in server.js to send it for real.
- Enrollment rules enforced: contact verified, prerequisite courses passed, prerequisite tasks completed,
  one section per course (FR-09), no timetable clash, seat limit with waitlist.
