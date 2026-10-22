import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "wasp/client/auth";

export function useRedirectIfLoggedIn(redirectTo = "/demo-app") {
  const { data: user, isError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user && !isError) {
      navigate(redirectTo);
    }
  }, [user, isError, navigate, redirectTo]);
}
