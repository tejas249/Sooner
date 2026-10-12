"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { performBoardAction, type BoardAction } from "../../web/admin-actions.ts";
import { webPool } from "../../web/db.ts";
import { requireAdmin } from "./auth.ts";

async function run(action: BoardAction, formData: FormData): Promise<never> {
  await requireAdmin();
  const outcome = await performBoardAction(webPool(), action, formData.get("board"), new Date());
  revalidatePath("/admin");
  redirect(`/admin?notice=${outcome}`);
}

export async function pollNowAction(formData: FormData): Promise<never> {
  return run("poll", formData);
}

export async function pauseAction(formData: FormData): Promise<never> {
  return run("pause", formData);
}

export async function resumeAction(formData: FormData): Promise<never> {
  return run("resume", formData);
}
