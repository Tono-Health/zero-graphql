import { createClient } from "zero-relay/client";
import type { Router } from "../router.ts";

export const api = createClient<Router>();
