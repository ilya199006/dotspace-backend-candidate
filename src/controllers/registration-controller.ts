import { NextFunction, Request, Response } from 'express';
import { Event, Registration, User, sequelize } from '../models';
function registrationJson(registration: Registration) {
  return {
    id: registration.id,
    eventId: registration.eventId,
    userId: registration.userId,
    createdAt: registration.createdAt,
  };
}

export async function registerForEvent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let { timeout } = req.body as { timeout?: number };
  try {
    const eventId = req.params.eventId as string;
    const { userId } = req.body as { userId?: string }
    const event = await Event.findByPk(eventId);
    const regCount = await Registration.count({
      where: { eventId },
    });
    if (!event) {
      res.status(404).json({
        error: { code: 'EVENT_NOT_FOUND', message: 'Event was not found' },
      });
      return;
    }
    const user = await User.findByPk(userId);
    if (!user) {
      res.status(404).json({
        error: { code: 'USER_NOT_FOUND', message: 'User was not found' },
      });
      return;
    }
    if (regCount >= event.capacity) {
      res.status(409).json({
        error: { code: 'EVENT_IS_FULL', message: 'There are no free places' },
      });
      return;
    }
    // валидация запроса должна выполняться раньше всего остального

    const sameRegistration = await Registration.findOne({
      where: { eventId, userId: user.id },
    });

    if (sameRegistration) {
      res.status(200).json({
        registration: {
          id: sameRegistration.id,
          eventId: sameRegistration.eventId,
          userId: sameRegistration.userId,
          createdAt: sameRegistration.createdAt,
        },
      });
      return;
    }
    // debugger
    // Оптимистичная блокировка c версионированием 
    // самый подходящий вариант для форм с регистрацией
    const registration = await sequelize.transaction(async (transaction) => {
      const created = await Registration.create({ eventId, userId: user.id }, { transaction });
      const [affected] = await Event.update(
        {
          version: (event.version || 0) + 1
        },
        {
          where: { id: eventId, version: event.version },
          transaction,
        },
      );
      if (affected === 0) {
        throw new Error('RegistrationBusy');
      }
      return created
    })

    res.status(201).json({ registration: registrationJson(registration) });
  } catch (error: any) {
    // поскольку далее идет middleware c хендлером на ошибки (500-ая)
    // а в тз указано, что при race condition их не должно быть,
    // будем повторять запросы через временные интервалы с экспоненциальным ростом
    // 100мс, 271мс, 738мс и тд
    if (error.message == 'RegistrationBusy' && Number(timeout) < 6) {
      req.body.timeout = (timeout || 0) + 1
      setTimeout(registerForEvent, Math.exp(timeout || 0) * 100, req, res, next)
    }
    else // должна выбрасываться ошибка в остальных случаях
      next(error);
  }
}
