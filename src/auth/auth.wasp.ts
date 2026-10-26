import { page, route, type Auth, type Spec } from "@wasp.sh/spec";
import { LoginPage } from "./LoginPage" with { type: "ref" };
import { SignupPage } from "./SignupPage" with { type: "ref" };

export const authConfig: Auth = {
  userEntity: "User",
  methods: { usernameAndPassword: {} },
  onAuthFailedRedirectTo: "/login",
  onAuthSucceededRedirectTo: "/demo-app",
};

export const authSpec: Spec = [
  route("LoginRoute", "/login", page(LoginPage)),
  route("SignupRoute", "/signup", page(SignupPage)),
];
