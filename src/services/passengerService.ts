import { FavoriteLocation, UserProfile } from '../../packages/shared_types/src';
import { MOCK_CUSTOMERS } from '../data/mockData';

class PassengerService {
  private customers: UserProfile[] = [...MOCK_CUSTOMERS];

  getAllPassengers(): UserProfile[] {
    return [...this.customers];
  }

  getPassengerById(id: string): UserProfile | undefined {
    return this.customers.find((c) => c.id === id);
  }

  updateWalletBalance(passengerId: string, deltaAmount: number): number {
    const passenger = this.customers.find((c) => c.id === passengerId);
    if (passenger) {
      passenger.walletBalance = Math.max(0, passenger.walletBalance + deltaAmount);
      passenger.updatedAt = new Date().toISOString();
      return passenger.walletBalance;
    }
    return 0;
  }

  getFavoriteLocations(passengerId: string): FavoriteLocation[] {
    const passenger = this.customers.find((c) => c.id === passengerId);
    if (passenger?.favoriteLocations && passenger.favoriteLocations.length > 0) {
      return passenger.favoriteLocations;
    }

    // Default Yemeni favorites
    return [
      {
        id: 'fav_home',
        title: 'المنزل (شارع حدة)',
        icon: 'HOME',
        location: { latitude: 12.8200, longitude: 45.0300, addressName: 'شارع حدة - بالقرب من بريد حدة' }
      },
      {
        id: 'fav_work',
        title: 'العمل (شارع الزبيري)',
        icon: 'WORK',
        location: { latitude: 12.7890, longitude: 45.0020, addressName: 'جولة الرويشان - شارع الزبيري' }
      },
      {
        id: 'fav_univ',
        title: 'جامعة عدن',
        icon: 'UNIVERSITY',
        location: { latitude: 12.8531, longitude: 44.9717, addressName: 'جامعة عدن - البوابة الشرقية' }
      }
    ];
  }

  toggleAccountStatus(passengerId: string, isActive: boolean): void {
    const p = this.customers.find((c) => c.id === passengerId);
    if (p) {
      p.isActive = isActive;
      p.updatedAt = new Date().toISOString();
    }
  }
}

export const passengerService = new PassengerService();
