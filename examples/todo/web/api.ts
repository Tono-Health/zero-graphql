import { createClient } from "zero-relay/client";
import type { Router } from "../routers/index.ts";

export const api = createClient<Router>();
