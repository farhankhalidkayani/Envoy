import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/** Verifies the bearer JWT and attaches the payload to req.user. */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {}
