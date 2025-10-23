#!/usr/bin/env node
/**
 * createSuperAdmin.mjs
 *
 * Usage:
 *   node createSuperAdmin.mjs <username> <password>
 *
 * Example:
 *   node createSuperAdmin.mjs superadmin templelaw123
 *
 * It reads optional env vars:
 *   MONGO_URI (default: mongodb://127.0.0.1:27017)
 *   MONGO_DB  (default: templelaw)
 *
 * NOTE: Run this from your server project folder where your MongoDB is accessible.
 */

import dotenv from "dotenv";
dotenv.config();

import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);
const username = argv[0] || "superadmin";
const password = argv[1] || "templelaw123";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB || "templelaw";

async function main() {
    if (!username || !password) {
        console.error("Usage: node createSuperAdmin.mjs <username> <password>");
        process.exit(1);
    }

    console.log(`Using Mongo URI: ${MONGO_URI}`);
    console.log(`Database: ${MONGO_DB}`);
    console.log(`Creating/updating user: ${username}`);

    try {
        const saltRounds = 10;
        const hash = await bcrypt.hash(password, saltRounds);

        const client = new MongoClient(MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });

        await client.connect();
        const db = client.db(MONGO_DB);
        const users = db.collection("users");

        // Upsert (create or replace) user entry. We do NOT modify other fields if they already exist,
        // but we set/replace the password, role and createdAt (createdAt only if inserted).
        const now = new Date();
        const result = await users.updateOne(
            { username },
            {
                $set: { password: hash, role: "superadmin", updatedAt: now },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true }
        );

        if (result.upsertedCount) {
            console.log(`Inserted new superadmin user '${username}'.`);
        } else if (result.modifiedCount) {
            console.log(`Updated password for existing user '${username}'.`);
        } else {
            console.log(`User '${username}' already exists and password was not changed (unexpected).`);
        }

        await client.close();
        console.log("Done. You can now login with that username/password at /login.");
    } catch (err) {
        console.error("Error:", err.message || err);
        process.exit(2);
    }
}

main();
