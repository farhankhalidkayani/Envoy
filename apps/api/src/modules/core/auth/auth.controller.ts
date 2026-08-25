import { Body, Controller, Post } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AuthService } from "./auth.service.js";

const RegisterDto = z.object({
  tenantName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const LoginDto = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RegisterAdminDto = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  bootstrapSecret: z.string().min(1),
});

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  register(@Body(new ZodValidationPipe(RegisterDto)) body: z.infer<typeof RegisterDto>) {
    return this.auth.registerTenant(body);
  }

  @Post("login")
  login(@Body(new ZodValidationPipe(LoginDto)) body: z.infer<typeof LoginDto>) {
    return this.auth.login(body.email, body.password);
  }

  @Post("register-admin")
  registerAdmin(
    @Body(new ZodValidationPipe(RegisterAdminDto)) body: z.infer<typeof RegisterAdminDto>,
  ) {
    return this.auth.registerAdmin(body);
  }
}
