export const UCP_SCHEMA_VERSION = "excalibur.ucp.v1";
export class UcpDeniedError extends Error {
    code;
    status;
    constructor(code, message, status = "denied") {
        super(message);
        this.name = "UcpDeniedError";
        this.code = code;
        this.status = status;
    }
}
