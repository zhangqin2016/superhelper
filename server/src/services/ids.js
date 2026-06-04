import { customAlphabet } from "nanoid";

const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const token = customAlphabet(alphabet, 8);
const idToken = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 14);

export function publicId(prefix) {
  return `${prefix}_${idToken()}`;
}

export function licenseKey() {
  return `LILY-${token()}-${token()}-${token()}`;
}
