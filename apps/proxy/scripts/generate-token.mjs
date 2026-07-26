import { randomBytes } from "node:crypto";

const token = randomBytes(32).toString("base64url");
console.log(token);
