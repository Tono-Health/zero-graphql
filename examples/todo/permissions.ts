import type { ExpressionFactory } from "@rocicorp/zero";
import type { User } from "./app.ts";
import type { schema } from "./schema.ts";

/** Lists the user owns or was added to. Use it in every query and mutation lookup on `list`. */
export const canSeeList =
  (user: User): ExpressionFactory<"list", typeof schema> =>
  (eb) =>
    eb.or(
      eb.cmp("ownerID", user.userID),
      eb.exists("members", (member) => member.where("userID", user.userID)),
    );
