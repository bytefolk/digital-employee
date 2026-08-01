export class DwsConnectorError extends Error {
  code: string
  details: Record<string, unknown>

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "DwsConnectorError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function dwsError(code: string, details: Record<string, unknown> = {}) {
  return new DwsConnectorError(code, details);
}
