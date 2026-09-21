import { Type } from "typebox";

export const object = <T extends Record<string, any>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const text = (description: string, maxLength = 4000) =>
  Type.String({ minLength: 1, maxLength, description });
export const choices = <T extends string>(values: T[], description?: string) =>
  Type.Unsafe<T>({ type: "string", enum: values, description });
