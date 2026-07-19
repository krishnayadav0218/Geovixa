# Krystal Connect — Web App

Ek hi Web App jisme **3 alag login sections** hain:

| Role | Login Kaise | Kya Kar Sakta Hai |
|---|---|---|
| 👤 **Employee** | **Employee ID + 4-6 digit PIN** (admin set karta hai) | Punch In / Punch Out (selfie + GPS location ke saath), apni **aaj ki attendance** dekh sakta hai, Salary Slip request kar sakta hai, aur **Leave Application** apply/track kar sakta hai |
| 🗂️ **Manager** | Username + Password | Sabhi employees ki attendance records **dekh** sakta hai aur Excel **download** kar sakta hai, apne project ki **Leave Applications approve/reject** kar sakta hai. Employee add/edit/delete nahi kar sakta |
| 🛡️ **Admin** | Username + Password | **Pura access** — employees add/edit/deactivate, sabhi records dekhna/download karna, naye Manager accounts banana, sabhi projects ki **Leave Applications approve/reject** karna, apna password change karna |

Website kholte hi ek landing page aayega jisme teeno role ke cards honge — user apna role choose karke us section me login karega.

---

## 📁 Project Structure

```
krystal-attendance/
└── backend/     → Node.js + Express API aur Web App dono isi ek folder se serve hote hain
```

---

## 🚀 Local Test Karna (apne computer pe)

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Browser me kholo: `http://localhost:5000`

Pehli baar chalate hi ek default **Admin** aur ek default **Manager** account apne aap ban jayega (sirf **local/dev** mein — production mein neeche dekho):

**Admin login:**
- Username: `admin`
- Password: `KrystalConnect@2026`

**Manager login:**
- Username: `manager`
- Password: `KrystalConnect@Mgr2026`

⚠️ **Production mein `ADMIN_PASSWORD` aur `MANAGER_PASSWORD` set karna ab zaroori hai** — agar `NODE_ENV=production` hai aur ye set nahi kiye to server start hi nahi hoga (taaki koi bhi default/guessable password ke saath live na chala jaye). Password kam se kam 8 characters ka ho aur usme letter + number dono ho. Pehli login ke baad **Settings** tab se password bhi change kar sakte ho.

---

## ☁️ Deploy Karna — Render.com

Is project mein ek `render.yaml` blueprint already included hai jo sahi settings khud set kar deta hai — **starter plan** (always-on, koi cold start nahi) aur ek **persistent disk** (selfie photos redeploy pe delete nahi hoti).

1. [render.com](https://render.com) pe account banao (GitHub se sign in)
2. Poora repo (ye `render.yaml` file ke saath) GitHub pe push karo
3. Render dashboard → **New → Blueprint** → apna repo select karo → Render `render.yaml` khud padh kar service + disk set kar dega
4. Deploy hone se pehle Render ke **Environment** tab me ye zaroor set karo (blueprint me `sync: false` hai matlab ye manually dalne honge):
   - `DATABASE_URL` — Supabase se
   - `JWT_SECRET` — ek lambi random string (`openssl rand -hex 48`)
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD` — apna khud ka strong password (8+ char, letter+number)
   - `MANAGER_USERNAME`, `MANAGER_PASSWORD` — same
   - (optional but recommended) `ADMIN_RECOVERY_KEY` — ek lambi random secret; ye set karne se agar Admin password bhool jaye to `/api/auth/recover-admin` route se recover kar sakte ho
5. Deploy hone ke baad URL milega, jaise `https://krystal-attendance.onrender.com` — yahi link sabko (Employee/Manager/Admin) bhejna hai.

⚠️ **Free tier use mat karo production ke liye** — free tier pe 15 min inactivity ke baad server "sleep" ho jata hai aur pehli request 30-60 sec slow ho sakti hai. `render.yaml` ka `plan: starter` (~$7/month) already isko avoid karta hai — bas Render dashboard me plan "Starter" hi rakhna, "Free" pe switch mat karna.

---

## 👤 Employee Kaise Use Karega

1. Website link kholega mobile/laptop browser me → **Employee** card pe tap karega
2. Apna **Employee ID** aur **PIN** dalega (dono Admin ne pehle se set kiye honge) → Login
3. Dashboard khulega — **Punch In (On Duty)** ya **Punch Out (Off Duty)** button dabayega
4. Browser camera permission mangega → live selfie capture hogi (koi gallery photo allow nahi)
5. Location permission bhi mangega → GPS location automatically capture hokar photo + status ke saath server pe chala jayega
6. Neeche **aaj ki attendance** dikhegi (date, status, location, time, photo) — sirf aaj ka data, purani history is table mein nahi aati (light aur private rehta hai)
7. **Apply for Leave** tab me jaake leave application daal sakta hai — Leave From date, Leave To date, Reason, aur optional attachment (photo/PDF/Word doc, max 5MB). Dates select karte hi form mein turant **total kitne din ki leave hai** (day count) dikh jata hai
8. Neeche **My Leave Applications** table me apni saari past applications aur unka status (Pending/Approved/Rejected) dekh sakta hai, har application ke saamne days count bhi dikhta hai

> Note: Camera aur Location dono ka browser permission allow karna zaroori hai. Best experience ke liye HTTPS URL (jo Render/Railway free deta hai) use karo — HTTP pe kai browsers camera/location block kar dete hain.

## 🗂️ Manager Kaise Use Karega

1. **Manager** card pe tap → Admin ne diya hua username/password dalega
2. **Overview** → aaj kaun On Duty/Off Duty hai, live dikhega
3. **Attendance Log** → date range / Employee ID se filter karke **Download Excel** kar sakta hai
4. **Employees** tab me list dekh sakta hai (view-only — add/edit/delete button nahi dikhega)
5. **Leave Requests** tab → apne project ki employees ki leave applications dekh sakta hai (date range, reason, days count, attachment), status/project se filter kar sakta hai, aur **Approve ✅ / Reject ❌** kar sakta hai. **Download Excel** se poora report (days count ke saath) nikaal sakta hai

## 🛡️ Admin Kaise Use Karega

1. **Admin** card pe tap → apna username/password dalega
2. **Employees** tab → naye employees add karo (Employee ID + Name + **Login PIN**, 4-6 digit, required), inactive/active toggle karo
3. **Managers** tab → naye Manager accounts banao ya remove karo
4. **Attendance Log** → filter + Excel download (Manager jaisa hi, plus full access)
5. **Leave Requests** tab → **sabhi projects** ki leave applications dekh/approve/reject kar sakta hai (Manager se scope me farak sirf ye hai ki Admin ko project-lock nahi hai)
6. **Settings** → apna admin password change karo

Employee ka PIN bhool jaye to Admin **Edit Employee** modal se "Reset Login PIN" field bhar ke naya PIN set kar sakta hai.

---

## 🏖️ Leave Management System

Employee apni **date range** (Leave From → Leave To), **reason**, aur optional **attachment** (medical certificate / supporting document — image, PDF, DOC, DOCX, max 5MB) ke saath leave application daal sakta hai. Application uske project ke Manager/Coordinator ya Admin ko review ke liye jaati hai.

**Day Count — har jagah automatic calculate hota hai:**
- Leave application form mein dates select karte hi live **"Total: X days"** preview dikhta hai (submit se pehle hi pata chal jaata hai)
- Employee ki **My Leave Applications** table mein "Days" column
- Manager/Admin ki **Leave Requests** table mein "Days" column
- Excel report download mein bhi "Days" column (from-to dates ke hisaab se inclusive count)

**Workflow:**
1. Employee → **Apply for Leave** tab → dates + reason (+ attachment) → **Submit**
2. Manager (apne project ki) ya Admin (sabhi projects) → **Leave Requests** tab → status/project se filter → **Approve ✅ / Reject ❌**
3. Employee apni application ka live status (Pending/Approved/Rejected) **My Leave Applications** table mein dekh sakta hai
4. Admin/Manager chahe to poora Excel report (Days count ke saath) **Download** kar sakta hai

**Project-scoping:** Salary Slip requests jaisa hi — Manager/Coordinator sirf apne project ki leave requests dekh/action kar sakta hai, Admin sabki dekh sakta hai.

---

## 🔐 Manager Account Kaise Banaye

Sirf **Admin** hi Manager accounts bana sakta hai:
Admin login → **Managers tab** → Username + Password (min 6 characters) dalke **+ Add Manager** dabao. Wahi credentials Manager ko login karne ke liye do.

---

## 📊 Har Punch Me Kya Record Hota Hai
- Employee ID, Name
- Status: **On Duty** / **Off Duty**
- Selfie photo (live capture, koi gallery upload nahi)
- GPS Latitude, Longitude + approximate address (auto-detect)
- Exact Date & Time

---

## 🔒 Security Notes
- `.env` me `ADMIN_PASSWORD`, `MANAGER_PASSWORD` aur `JWT_SECRET` production me zaroor set karo — **agar `NODE_ENV=production` hai aur ye set nahi kiye to server start hi nahi hoga**, taaki koi bhi default/guessable password ke saath live na chala jaye
- Passwords (Admin/Manager) ab **kam se kam 8 characters + ek letter + ek number** honi chahiye — sirf length check nahi, ek real policy hai
- **Employee login ab Employee ID + PIN dono maangta hai** (pehle sirf Employee ID kaafi tha, jo ek security gap tha kyunki Employee ID koi secret nahi hai — ID card/reports pe dikhta hai). Admin har employee ka 4-6 digit PIN set karta hai; PIN bhi bcrypt se hashed hoke store hota hai, plain text kahin nahi
- Purane employees jinke paas pehle se PIN nahi tha, unke liye server pehli baar chalne par khud PIN generate karke ek local file (`generated_employee_pins_*.txt`) me likh deta hai — Admin ko wo file check karke employees ko unka PIN batana hai, phir file delete kar deni chahiye
- Manager ko sirf **view + download** access hai — koi bhi data edit/delete nahi kar sakta
- Sabhi passwords aur PINs bcrypt se hashed hoke DB me store hote hain, plain text me kahin nahi
- **JWT (JSON Web Token) based secure authentication** — login hone par ek signed token milta hai jo har request ke saath bhejna padta hai; token 12 ghante me expire ho jata hai
- **Auto logout on browser close** — session ab `sessionStorage` me store hota hai (localStorage nahi), isliye browser/tab band karte hi session clear ho jata hai aur dubara khud login karna padega
- **Brute-force protection** — koi bhi ek IP se 15 minute me 8 se zyada galat login attempt karega to temporarily block ho jayega (sabhi login endpoints: Employee/Manager/Admin)
- **Helmet security headers** enabled — common web attacks (clickjacking, MIME sniffing, etc.) se basic protection
- **Admin password recovery** — agar Admin apna password bhool jaye aur login na kar paaye, `ADMIN_RECOVERY_KEY` env variable set karke `/api/auth/recover-admin` route se naya password set kiya ja sakta hai (ye route tab tak disabled rehta hai jab tak ye key set na ho)

## 🆘 Common Issues

| Problem | Solution |
|---|---|
| Camera/Location permission popup nahi aa raha | HTTPS URL use karo (HTTP par browsers block karte hain), browser settings me site permissions check karo |
| Employee login "Incorrect Employee ID" | Admin panel se pehle us Employee ID ko add karna hoga |
| Manager ko "Access denied" aa raha | Manager account admin ne Managers tab se banaya hai ya nahi check karo |
| Excel download empty aa raha | Abhi tak kisi ne punch nahi kiya, ya date filter galat hai |

---

## 🆕 Recent Updates (Changelog)

- ✅ **Leave Management module** — employee leave application (apply, track status), Manager/Admin approve-reject workflow, project-scoped visibility, Excel export
- ✅ **Attachment support** for leave applications — image, PDF, DOC, DOCX (max 5MB)
- ✅ **Automatic day-count** — live preview while applying, plus "Days" column in every leave table and the Excel report
- 🐛 Fixed: Leave application submit failing with "Something went wrong" (route registration + missing attachment-storage module)
- 🐛 Fixed: Today's Attendance table showing a correct count but blank rows (missing fields in the attendance API response)

---

Made for **Krystal Connect**
Developed by **Krishna Yadav**
