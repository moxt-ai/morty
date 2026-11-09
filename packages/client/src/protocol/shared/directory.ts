import { z } from "zod";

export const MAX_WORKSPACE_PATH_LENGTH = 4_096;
export const isDirectoryPath = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= MAX_WORKSPACE_PATH_LENGTH && !value.includes("\0");
export const DIRECTORY_PATH = z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH).refine(isDirectoryPath);
