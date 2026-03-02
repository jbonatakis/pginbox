import { db } from "../db";

export async function getLists() {
  return db.selectFrom("lists").selectAll().orderBy("name").execute();
}
