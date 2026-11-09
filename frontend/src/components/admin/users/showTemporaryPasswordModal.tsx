import { Button, Stack } from "@mantine/core";
import { useModals } from "@mantine/modals";
import useTranslate, {
  translateOutsideContext,
} from "../../../hooks/useTranslate.hook";
import { copyToClipboard } from "../../../utils/clipboard.util";
import toast from "../../../utils/toast.util";

type ModalsContextProps = ReturnType<typeof useModals>;

/**
 * Exibe a senha temporária gerada pelo backend uma única vez — usada tanto na
 * criação de usuário quanto no reset de senha feito pelo administrador.
 */
const showTemporaryPasswordModal = (
  modals: ModalsContextProps,
  temporaryPassword: string,
) => {
  const t = translateOutsideContext();
  return modals.openConfirmModal({
    title: t("admin.users.modal.create.temporaryPassword"),
    children: (
      <Stack gap="md">
        <p>{t("admin.users.modal.create.temporaryPassword.warning")}</p>
        <div
          style={{
            background: "var(--mantine-color-gray-1)",
            padding: "md",
            borderRadius: "md",
            fontFamily: "monospace",
            wordBreak: "break-all",
          }}
        >
          {temporaryPassword}
        </div>
        <Button
          onClick={() => {
            copyToClipboard(temporaryPassword);
            toast.success(t("common.notify.copied"));
          }}
        >
          {t("common.button.copy")}
        </Button>
      </Stack>
    ),
    labels: {
      confirm: t("common.button.done"),
      cancel: t("common.button.cancel"),
    },
    cancelProps: { style: { display: "none" } },
    onClose: () => modals.closeAll(),
  });
};

export default showTemporaryPasswordModal;
