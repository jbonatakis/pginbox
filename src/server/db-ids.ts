export type DbInt8Value = bigint | number | string;

export function toDbInt8(value: DbInt8Value): string {
  return String(value);
}

export function toDbInt8List(values: readonly DbInt8Value[]): string[] {
  return values.map(toDbInt8);
}
