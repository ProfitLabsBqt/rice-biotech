# Biotech Fuels — Procurement System

## Deploy to Render.com (Free, 5 minutes)

### Step 1 — Push to GitHub
1. Create a free GitHub account at github.com if you don't have one
2. Create a new repository called "biotech-fuels"
3. Upload all these files to that repository

### Step 2 — Deploy on Render
1. Go to render.com and sign up free
2. Click "New +" → "Web Service"
3. Connect your GitHub repo
4. Set these settings:
   - Name: biotech-fuels
   - Runtime: Node
   - Build Command: npm install
   - Start Command: node server.js
5. Click "Create Web Service"
6. Your app will be live at: https://biotech-fuels.onrender.com

### Default Login
- Username: admin
- Password: admin123
- CHANGE THIS IMMEDIATELY after first login

### First Steps After Login
1. Go to Admin tab
2. Change admin password
3. Create users for: Weighbridge Operator, Lab Chemist, Store/GRN team
4. Assign appropriate rights to each user

## Local Testing
```
npm install
node server.js
```
Then open http://localhost:3000
