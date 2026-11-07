import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetDatabase, signUp, testApp } from "./helpers.js";

describe("authentication", () => {
  beforeEach(resetDatabase);

  it("registers a user, creates their first workspace, and signs them in", async () => {
    const res = await request(testApp())
      .post("/api/auth/register")
      .send({
        email: "Founder@Example.com",
        password: "correct-horse-1",
        name: "Founder",
        workspaceName: "Acme",
      })
      .expect(201);

    expect(res.body.user.email).toBe("founder@example.com");
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0].role).toBe("owner");
    expect(res.headers["set-cookie"]?.[0]).toContain("workos_session=");
    expect(res.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    // The password hash must never leave the server.
    expect(JSON.stringify(res.body)).not.toContain("correct-horse-1");
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("rejects a weak password with field-level detail", async () => {
    const res = await request(testApp())
      .post("/api/auth/register")
      .send({ email: "weak@example.com", password: "short", name: "Weak" })
      .expect(422);

    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.details.password).toBeDefined();
  });

  it("treats email as case-insensitive and refuses a duplicate", async () => {
    await request(testApp())
      .post("/api/auth/register")
      .send({ email: "dup@example.com", password: "correct-horse-1", name: "First" })
      .expect(201);

    const res = await request(testApp())
      .post("/api/auth/register")
      .send({ email: "DUP@example.com", password: "correct-horse-1", name: "Second" })
      .expect(409);

    expect(res.body.error.code).toBe("conflict");
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await request(testApp())
      .post("/api/auth/register")
      .send({ email: "real@example.com", password: "correct-horse-1", name: "Real" })
      .expect(201);

    const wrongPassword = await request(testApp())
      .post("/api/auth/login")
      .send({ email: "real@example.com", password: "wrong-horse-9" })
      .expect(401);

    const unknownUser = await request(testApp())
      .post("/api/auth/login")
      .send({ email: "ghost@example.com", password: "correct-horse-1" })
      .expect(401);

    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it("requires a session for protected routes", async () => {
    const res = await request(testApp()).get("/api/auth/me").expect(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("ends the session on logout", async () => {
    const client = await signUp();
    await client.get("/api/auth/me").expect(200);

    await request(testApp()).post("/api/auth/logout").set("Cookie", client.cookie).expect(204);

    await request(testApp()).get("/api/auth/me").set("Cookie", client.cookie).expect(401);
  });

  it("changes a password and signs out other devices", async () => {
    const client = await signUp();

    // A second sign-in from "another device".
    const other = await request(testApp())
      .post("/api/auth/login")
      .send({ email: client.email, password: "test-password-1" })
      .expect(200);
    const otherCookie = String(other.headers["set-cookie"]?.[0]).split(";")[0]!;

    const res = await client
      .post("/api/auth/change-password", {
        currentPassword: "test-password-1",
        newPassword: "brand-new-password-2",
      })
      .expect(200);

    expect(res.body.otherSessionsEndedCount).toBeGreaterThanOrEqual(1);
    // The device that changed the password stays signed in.
    await client.get("/api/auth/me").expect(200);
    // The other one does not.
    await request(testApp()).get("/api/auth/me").set("Cookie", otherCookie).expect(401);

    await request(testApp())
      .post("/api/auth/login")
      .send({ email: client.email, password: "brand-new-password-2" })
      .expect(200);
  });

  it("rejects a password change when the current password is wrong", async () => {
    const client = await signUp();
    const res = await client
      .post("/api/auth/change-password", {
        currentPassword: "not-my-password",
        newPassword: "brand-new-password-2",
      })
      .expect(400);
    expect(res.body.error.details?.currentPassword).toBeDefined();
  });
});
