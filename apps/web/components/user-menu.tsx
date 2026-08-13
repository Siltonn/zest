"use client";

import { Avatar, Dropdown } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme";
import { CheckIcon, MonitorIcon, MoonIcon, SignOutIcon, SunIcon } from "./icons";

type Me = {
  user: { id: string; name: string; email: string; image: string | null } | null;
  actor: { kind: string };
  workspace: { id: string; name: string } | null;
};

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
 */
export function UserMenu({ collapsed }: { collapsed: boolean }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const { data } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/me"),
  });

  const signOut = async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
    router.push("/sign-in");
    router.refresh();
  };

  const user = data?.user;
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
              {user?.email ?? data?.actor.kind ?? "…"}
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
          <Dropdown.Item id="sign-out" onAction={signOut}>
            <SignOutIcon className="size-4 opacity-70" />
            Sign out
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
