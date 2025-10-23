import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getDb } from "./db.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "templelawsecret";

// ---------- Register new user (superadmin only) ----------
export async function registerUser(username, password, role = "admin") {
  const db = await getDb();
  const existing = await db.collection("users").findOne({ username });
  if (existing) throw new Error("Username already exists");

  const hashed = await bcrypt.hash(password, 10);
  await db.collection("users").insertOne({
    username,
    password: hashed,
    role,
    createdAt: new Date(),
  });
  return { username, role };
}

// ---------- Login ----------
export async function loginUser(username, password) {
  const db = await getDb();
  const user = await db.collection("users").findOne({ username });
  if (!user) throw new Error("Invalid username or password");

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) throw new Error("Invalid username or password");

  const token = jwt.sign(
    { username, role: user.role },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
  return { token, role: user.role, username };
}

// ---------- Verify token ----------
export function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
