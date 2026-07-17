# Auth Testing Playbook (Emergent Auth) — Umbra Collective

## Step 1: Create test admin + session
```
mongosh --eval "
use('test_database');
var uid='test-admin-'+Date.now();
var tok='test_admin_'+Date.now();
db.users.insertOne({user_id:uid,email:'admin.'+Date.now()+'@umbra.test',name:'Admin Test',picture:'',phone:'',role:'admin',created_at:new Date().toISOString()});
db.user_sessions.insertOne({user_id:uid,session_token:tok,expires_at:new Date(Date.now()+7*24*3600*1000).toISOString(),created_at:new Date().toISOString()});
print('TOKEN='+tok);
print('UID='+uid);
"
```

## Step 2: Auth endpoints via curl
```
curl -X GET https://<host>/api/auth/me -H "Authorization: Bearer <TOKEN>"
```
Expect 200 with user object including `role: admin`.

## Step 3: Browser via cookie
```
await page.context.add_cookies([{
  "name":"session_token","value":"<TOKEN>","domain":"<host>","path":"/","httpOnly":True,"secure":True,"sameSite":"None"
}]);
await page.goto("https://<host>/my-tickets");
```

## Success indicators
- /api/auth/me returns 200 user
- /admin loads for admin role
- /scan loads for admin or door role
