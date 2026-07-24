// Web Push config. The VAPID *public* key is meant to be public in client code —
// it only lets the browser create a push subscription; the private key (kept in
// Vercel env vars, never here) is what authorizes actually sending a push.
//
// The subscription itself is written straight to Firestore by the signed-in client
// (protected by the same security rules as tasks), so no separate endpoint is needed.
//
// Leave VAPID_PUBLIC_KEY null to hide the reminders feature entirely.
export const VAPID_PUBLIC_KEY = "BJ49WUqccbdqZ7nUV8PRjV7BBS7orZOXl7WobYa3pMdP5AJhNUcZtXh5PRrnfKYZUqBBT63Jjt2DlU_gnMggGtw";
