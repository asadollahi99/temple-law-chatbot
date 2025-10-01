import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

let client, db;
export async function getDb() {
    if (!client) {
        client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
        db = client.db(); // db name is in URI
        // indexes (helpful for prefilter & joins)
        await db.collection("pages").createIndex({ url: 1 }, { unique: true });
        await db.collection("chunks").createIndex({ url: 1 });
        await db.collection("chunks").createIndex({ text: "text" }); // keyword prefilter
        //await db.collection("sessions").createIndex({ sid: 1 }, { unique: true });
        // ensure indexes (idempotent)

        await db.collection("sessions").createIndex({ sid: 1 }, { unique: true });
        await db.collection("sessions").createIndex({ updatedAt: -1 });
        await db.collection("sessions").createIndex({ "history.content": "text" }); // text search
    }
    return db;
}
