# Krystal Connect — Web App

Ek hi Web App jisme **3 alag login sections** hain:

| Role | Login Kaise | Kya Kar Sakta Hai |
|---|---|---|
| 👤 **Employee** | Sirf apna **Employee ID** dalke (password nahi chahiye) | Punch In / Punch Out (selfie + GPS location ke saath), apni attendance history dekh sakta hai |
| 🗂️ **Manager** | Username + Password | Sabhi employees ki attendance records **dekh** sakta hai aur Excel **download** kar sakta hai. Employee add/edit/delete nahi kar sakta |
| 🛡️ **Admin** | Username + Password | **Pura access** — employees add/edit/deactivate, sabhi records dekhna/download karna, naye Manager accounts banana, apna password change karna |

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

Pehli baar chalate hi ek default **Admin** aur ek default **Manager** account apne aap ban jayega:

**Admin login:**
- Username: `admin`
- Password: `KrystalConnect@2026`

**Manager login:**
- Username: `manager`
- Password: `KrystalConnect@Mgr2026`

⚠️ Live/production me deploy karne se pehle `.env` file me `ADMIN_PASSWORD`, `MANAGER_PASSWORD` aur `JWT_SECRET` zaroor change kar lena. Pehli login ke baad **Settings** tab se password bhi change kar sakte ho.

---

## ☁️ Deploy Karna (Free) — Render.com

1. [render.com](https://render.com) pe free account banao (GitHub se sign in)
2. `backend` folder ko GitHub repo me push karo
3. Render dashboard → **New → Web Service** → apna repo select karo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment Variables** (`.env.example` dekho): `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`
5. Deploy hone ke baad URL milega, jaise `https://krystal-attendance.onrender.com` — yahi link sabko (Employee/Manager/Admin) bhejna hai.

⚠️ Free tier pe 15 min inactivity ke baad server "sleep" ho jata hai — pehli request thodi slow (30-60 sec) ho sakti hai.

---

## 👤 Employee Kaise Use Karega

1. Website link kholega mobile/laptop browser me → **Employee** card pe tap karega
2. Apna **Employee ID** dalega (jo Admin ne pehle se add kiya hoga) → Login
3. Dashboard khulega — **Punch In (On Duty)** ya **Punch Out (Off Duty)** button dabayega
4. Browser camera permission mangega → live selfie capture hogi (koi gallery photo allow nahi)
5. Location permission bhi mangega → GPS location automatically capture hokar photo + status ke saath server pe chala jayega
6. Neeche apni **poori attendance history** dekh sakta hai (date, status, location, time, photo)

> Note: Camera aur Location dono ka browser permission allow karna zaroori hai. Best experience ke liye HTTPS URL (jo Render/Railway free deta hai) use karo — HTTP pe kai browsers camera/location block kar dete hain.

## 🗂️ Manager Kaise Use Karega

1. **Manager** card pe tap → Admin ne diya hua username/password dalega
2. **Overview** → aaj kaun On Duty/Off Duty hai, live dikhega
3. **Attendance Log** → date range / Employee ID se filter karke **Download Excel** kar sakta hai
4. **Employees** tab me list dekh sakta hai (view-only — add/edit/delete button nahi dikhega)

## 🛡️ Admin Kaise Use Karega

1. **Admin** card pe tap → apna username/password dalega
2. **Employees** tab → naye employees add karo (Employee ID + Name required), inactive/active toggle karo
3. **Managers** tab → naye Manager accounts banao ya remove karo
4. **Attendance Log** → filter + Excel download (Manager jaisa hi, plus full access)
5. **Settings** → apna admin password change karo

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
- `.env` me `ADMIN_PASSWORD`, `MANAGER_PASSWORD` aur `JWT_SECRET` production me zaroor change karo
- Employee login sirf Employee ID se hota hai (koi password nahi) — jaisa maanga gaya tha. Sirf Admin ka **feed kiya hua exact Employee ID** match karega; galat ID daalne par "Incorrect Employee ID" error aayega aur login nahi hoga. Employee ID confidential rakhna zaroori hai; extra security chahiye to future me OTP/PIN add kiya ja sakta hai
- Manager ko sirf **view + download** access hai — koi bhi data edit/delete nahi kar sakta
- Sabhi passwords bcrypt se hashed hoke DB me store hote hain, plain text me kahin nahi
- **JWT (JSON Web Token) based secure authentication** — login hone par ek signed token milta hai jo har request ke saath bhejna padta hai; token 12 ghante me expire ho jata hai
- **Auto logout on browser close** — session ab `sessionStorage` me store hota hai (localStorage nahi), isliye browser/tab band karte hi session clear ho jata hai aur dubara khud login karna padega
- **Brute-force protection** — koi bhi ek IP se 15 minute me 8 se zyada galat login attempt karega to temporarily block ho jayega (sabhi login endpoints: Employee/Manager/Admin)
- **Helmet security headers** enabled — common web attacks (clickjacking, MIME sniffing, etc.) se basic protection

## 🆘 Common Issues

| Problem | Solution |
|---|---|
| Camera/Location permission popup nahi aa raha | HTTPS URL use karo (HTTP par browsers block karte hain), browser settings me site permissions check karo |
| Employee login "Incorrect Employee ID" | Admin panel se pehle us Employee ID ko add karna hoga |
| Manager ko "Access denied" aa raha | Manager account admin ne Managers tab se banaya hai ya nahi check karo |
| Excel download empty aa raha | Abhi tak kisi ne punch nahi kiya, ya date filter galat hai |

---

Made for **Krystal Connect**
