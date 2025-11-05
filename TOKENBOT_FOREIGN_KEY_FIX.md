# TokenBot Foreign Key Constraint Fix

## Issue
TokenBot service was failing with foreign key constraint violation when trying to log token generation attempts:

```
error: insert or update on table "token_generation_logs" violates foreign key constraint "token_generation_logs_user_id_fkey"
detail: Key (user_id)=(f49bc51c-88d0-5ddc-ae5f-9522ae27e209) is not present in table "kite_user_credentials"
```

## Root Cause
- TokenBot's `logAttempt()` method tries to insert into `token_generation_logs` table
- The table has a foreign key constraint referencing `kite_user_credentials` table
- When backend calls TokenBot with a `user_id` that doesn't exist in `kite_user_credentials`, the insert fails
- This happens when credentials haven't been stored in TokenBot yet

## Fix Applied

### 1. Check User Existence Before Logging
```javascript
// Check if user exists in kite_user_credentials before logging
const userCheck = await db.query(
  `SELECT user_id FROM kite_user_credentials WHERE user_id = $1`,
  [userId]
);

if (userCheck.rows.length === 0) {
  // User doesn't exist - log warning but don't fail
  logger.warn(`⚠️ Cannot log attempt for user ${userId}: User not found in kite_user_credentials. Credentials must be stored first.`);
  return;
}
```

### 2. Make Logging Non-Blocking
- Logging errors no longer break token refresh operations
- Added try-catch around logging in error handler
- Logging failures are logged as warnings, not errors

### 3. Enhanced Error Logging
- Added detailed error context (errorCode, constraint, userId)
- Better debugging information

## Result
- ✅ No more foreign key constraint violations
- ✅ Token refresh operations continue even if logging fails
- ✅ Clear warnings when credentials are missing
- ✅ Better error visibility for debugging

## Next Steps
1. **Backend should store credentials first** before calling TokenBot refresh
2. **Verify credentials exist** in `kite_user_credentials` table before refresh attempts
3. **Monitor logs** for warnings about missing credentials

