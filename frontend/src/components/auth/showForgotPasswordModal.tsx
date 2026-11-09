import { Button, Group, Stack, Text } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { FormattedMessage } from "react-intl";
import useTranslate, {
  translateOutsideContext,
} from "../../hooks/useTranslate.hook";

type ModalsContextProps = ReturnType<typeof useModals>;

const showForgotPasswordModal = (modals: ModalsContextProps) => {
  const t = translateOutsideContext();
  return modals.openModal({
    title: t("signin.forgot-password.modal.title"),
    children: (
      <Stack align="stretch">
        <Text size="sm">
          <FormattedMessage id="signin.forgot-password.modal.description" />
        </Text>
        <Group justify="flex-end" mt="md">
          <Button
            color="blue"
            variant="filled"
            onClick={() => modals.closeAll()}
          >
            <FormattedMessage id="common.button.understood" />
          </Button>
        </Group>
      </Stack>
    ),
  });
};

export default showForgotPasswordModal;
