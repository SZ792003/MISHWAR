# Firebase Rules Test Foundation

This folder documents the minimum emulator tests required before Stage 7B/production deployment.

## Required Tooling

Install the Firebase CLI and rules test packages in a dedicated test workspace before enabling automated rules tests:

```powershell
npm install --save-dev @firebase/rules-unit-testing firebase
firebase emulators:start --only auth,firestore,storage
```

## Firestore Test Cases

- Unauthenticated users cannot read or write protected collections.
- A customer can read only their own user/passenger profile.
- A driver can read only their own driver/KYC profile where allowed.
- A customer can create a ride for their own `customerId`.
- A customer cannot create a ride for another user.
- A customer can read their own ride.
- A driver can read an assigned ride.
- A driver cannot read an unrelated ride.
- A driver cannot update `paymentStatus` on a ride.
- Admin can update protected ride fields.
- Driver location is readable by the assigned customer only while the ride is trackable.
- Driver location is not readable by unrelated authenticated users.
- Financial collections cannot be written by customer or driver clients.
- Audit logs cannot be created, updated, or deleted by clients.
- `KYC_REVIEWER` can review driver KYC records.
- Device token create/update requires `userId == request.auth.uid`.
- Device token records require `role`, `platform`, `app`, timestamps, and `enabled`.
- Customers and drivers cannot create notification documents directly.
- Notification read/update is limited to the owning user or admin.

## Storage Test Cases

- Unauthenticated users cannot read or write any object.
- A user can upload their own profile/avatar image under 5 MB.
- A user cannot upload another user's profile/avatar image.
- Profile and vehicle media are not public.
- A driver can upload KYC images or PDFs under 10 MB.
- A driver cannot upload unsupported executable or archive content types.
- `KYC_REVIEWER` can read driver KYC files.
- Unmatched paths are denied.

## Stage 7B FCM Backend Test Cases

- Valid token registration creates an enabled token record.
- Multiple devices for the same user are retained.
- Logout disables the current token only.
- Invalid FCM responses disable only rejected tokens.
- Driver offer push targets eligible online drivers.
- Unrelated drivers are not notified for targeted offers.
- Duplicate ride notification events are de-duplicated by event key.
- Push payload sanitizer removes sensitive fields.

## Status

The repository now has rules and a test plan. Executable rules tests still require the Firebase emulator/tooling setup and real project assumptions to be selected.
