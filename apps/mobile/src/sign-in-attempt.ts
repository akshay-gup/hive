import { apiUrl } from "./api";
import { signInAttempts } from "./sign-in-proof";
import { storage } from "./storage";

const attempts = signInAttempts(storage, apiUrl);

export const beginSignIn = attempts.begin;
export const takeSignInAttempt = attempts.take;
export const cancelSignIn = attempts.cancel;
