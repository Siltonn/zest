"use client";

import { Avatar, Dropdown } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { useTheme, type Theme } from "@/lib/theme";
import {
  CheckIcon,
  MonitorIcon,
  MoonIcon,
  SignInIcon,
  SignOutIcon,
  SunIcon,
} from "./icons";

const THEMES: { id: Theme; label: string; icon: typeof SunIcon }[] = [
  { id: "light", label: "Light", icon: SunIcon },
  { id: "dark", label: "Dark", icon: MoonIcon },
  { id: "system", label: "System", icon: MonitorIcon },
];

/**
 * Who you are signed in as, how to change the theme, and how to leave.
 *
 * These belong together at the bottom of the sidebar rather than scattered:
 * it is the one place people look for account controls, and putting the theme
 * switch anywhere else means hunting for it.
 *
 * The last item follows the session rather than assuming one. Offering "Sign
 * out" to someone the backend does not recognise — which is what this did —
 * is worse than useless: it is the one control that could have taken them
 * somewhere, pointed the wrong way.
 */
export function UserMenu({ collapsed }: { collapsed: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const { status, me } = useSession();

  const user = me?.user ?? null;
  const signedIn = status === "authenticated" && user !== null;

  const signOut = async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
    // Drop every cached answer that was scoped to that session, so the next
    // person to sign in never sees the last one's workspace for a beat.
    queryClient.clear();
    // `replace`, not `push`: Back should not walk into an app they just left.
    router.replace("/sign-in");
  };

  const initials = (user?.name ?? "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("");

  return (
    <Dropdown>
      <Dropdown.Trigger
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-default-100 ${
          collapsed ? "justify-center" : ""
        }`}
      >
        <Avatar className="size-7 shrink-0">
          {user?.image && <Avatar.Image src={user.image} alt="" />}
          <Avatar.Fallback className="text-xs">{initials}</Avatar.Fallback>
        </Avatar>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-tight">
              {user?.name ?? "Not signed in"}
            </div>
            <div className="truncate text-xs leading-tight opacity-50">
              {user?.email ?? me?.actor.kind ?? "…"}
            </div>
          </div>
        )}
      </Dropdown.Trigger>

      <Dropdown.Popover placement="top start" className="w-56">
        <Dropdown.Menu>
          {THEMES.map((option) => (
            <Dropdown.Item
              key={option.id}
              id={option.id}
              onAction={() => setTheme(option.id)}
            >
              <option.icon className="size-4 opacity-70" />
              <span className="flex-1">{option.label}</span>
              {theme === option.id && <CheckIcon className="size-4" />}
            </Dropdown.Item>
          ))}
          {signedIn ? (
            <Dropdown.Item id="sign-out" onAction={signOut}>
              <SignOutIcon className="size-4 opacity-70" />
              Sign out
            </Dropdown.Item>
          ) : (
            <Dropdown.Item id="sign-in" onAction={() => router.push("/sign-in")}>
              <SignInIcon className="size-4 opacity-70" />
              Sign in
            </Dropdown.Item>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
